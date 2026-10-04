const ppro = require('premierepro');
const { storage } = require('uxp');
const {
  chunks,
  errorMessage,
  framesToTicks,
  markerComments,
  markerKey,
  ownsMarker,
  parseVideoLink,
  rateFromTimebase,
  tokenKey,
  versionName,
} = require('./markers.js');

const BATCH = 50;
const $ = (id) => document.getElementById(id);

function setStatus(message, isError = false) {
  const status = $('status');
  status.textContent = message;
  status.className = isError ? 'error' : '';
}

// Tokens live in UXP secure storage, one per server, and are only filled in for the
// server they were saved for.
async function tokenFor(origin) {
  try {
    const saved = await storage.secureStorage.getItem(tokenKey(origin));
    return saved ? new TextDecoder().decode(saved) : '';
  } catch {
    return '';
  }
}

// A changed link invalidates the loaded versions and may point at another server.
async function onLinkChange() {
  $('version').innerHTML = '';
  $('sync').disabled = true;
  const link = parseVideoLink($('link').value);
  $('server').textContent = link ? `Server: ${link.origin}` : '';
  $('token').value = link ? await tokenFor(link.origin) : '';
}

function readLink() {
  const link = parseVideoLink($('link').value);
  if (!link) {
    throw new Error(
      'Paste the address of an OpenFrame video page (https, or http on this machine or local network).'
    );
  }
  if (!$('token').value.trim()) throw new Error(`Paste an OpenFrame API token for ${link.origin}.`);
  return link;
}

async function api(origin, path) {
  const response = await fetch(`${origin}${path}`, {
    headers: { Authorization: `Bearer ${$('token').value.trim()}` },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(errorMessage(response.status, body));
  return body.data;
}

async function loadVersions() {
  try {
    const link = readLink();
    localStorage.setItem('openframe.link', $('link').value.trim());
    await storage.secureStorage.setItem(tokenKey(link.origin), $('token').value.trim());
    setStatus('Loading versions…');
    const video = await api(
      link.origin,
      `/api/projects/${encodeURIComponent(link.projectId)}/videos/${encodeURIComponent(link.videoId)}?includeComments=false`
    );
    const picker = $('version');
    picker.innerHTML = '';
    for (const version of video.versions) {
      const option = document.createElement('option');
      option.value = version.id;
      option.textContent = versionName(version);
      picker.appendChild(option);
    }
    $('sync').disabled = video.versions.length === 0;
    setStatus(`${video.title}: ${video.versions.length} version(s).`);
  } catch (error) {
    setStatus(error.message, true);
  }
}

function runTransaction(project, label, build) {
  let ok = false;
  project.lockedAccess(() => {
    ok = project.executeTransaction((compound) => build(compound), label);
  });
  if (!ok) throw new Error(`Premiere refused: ${label}.`);
}

async function syncMarkers() {
  const button = $('sync');
  button.disabled = true;
  try {
    const link = readLink();
    const versionId = $('version').value;
    if (!versionId) throw new Error('Load the versions and pick one.');

    const project = await ppro.Project.getActiveProject();
    const sequence = project && (await project.getActiveSequence());
    if (!sequence) throw new Error('Open a sequence in the timeline first.');
    const rate = rateFromTimebase(await sequence.getTimebase());
    if (!rate) throw new Error('This sequence frame rate is not supported.');
    const palette = ppro.Constants && ppro.Constants.MarkerColor;
    if (!palette) throw new Error('This Premiere version has no marker colors in its API.');

    setStatus('Fetching comments…');
    const query = new URLSearchParams({
      format: 'markers',
      fps: rate,
      includeResolved: String($('resolved').checked),
    });
    const data = await api(
      link.origin,
      `/api/versions/${encodeURIComponent(versionId)}/comments/export?${query}`
    );
    const colorByKey = new Map();
    for (const marker of data.markers) {
      const color = marker.premiereColor ? palette[marker.premiereColor] : undefined;
      if (color !== undefined) {
        colorByKey.set(
          markerKey(framesToTicks(marker.startFrame, rate), markerComments(marker, versionId)),
          color
        );
      }
    }

    // What an earlier sync of this version wrote, collected before anything changes.
    const markers = await ppro.Markers.getMarkers(sequence);
    const owned = [];
    for (const marker of markers.getMarkers()) {
      if (ownsMarker(await marker.getComments(), versionId)) owned.push(marker);
    }

    // Add first and remove after, so a refused step never leaves the sequence with
    // fewer comments than before.
    const tick = (frames) => ppro.TickTime.createWithTicks(framesToTicks(frames, rate));
    for (const batch of chunks(data.markers, BATCH)) {
      runTransaction(project, 'Add OpenFrame markers', (compound) => {
        for (const marker of batch) {
          compound.addAction(
            markers.createAddMarkerAction(
              marker.name,
              ppro.Marker.MARKER_TYPE_COMMENT,
              tick(marker.startFrame),
              tick(marker.durationFrames),
              markerComments(marker, versionId)
            )
          );
        }
      });
    }
    for (const batch of chunks(owned, BATCH)) {
      runTransaction(project, 'Remove old OpenFrame markers', (compound) => {
        for (const marker of batch) compound.addAction(markers.createRemoveMarkerAction(marker));
      });
    }

    // Adding a marker takes no color and returns no handle, so the new markers are
    // found again by their start and text, and colored in a second step.
    const fresh = await ppro.Markers.getMarkers(sequence);
    const coloring = [];
    for (const marker of fresh.getMarkers()) {
      const start = await marker.getStart();
      const color = colorByKey.get(markerKey(start.ticks, await marker.getComments()));
      if (color !== undefined) coloring.push([marker, color]);
    }
    for (const batch of chunks(coloring, BATCH)) {
      runTransaction(project, 'Color OpenFrame markers', (compound) => {
        for (const [marker, color] of batch) {
          compound.addAction(marker.createSetColorByIndexAction(color));
        }
      });
    }

    const lines = [
      `Added ${data.markers.length} marker(s) from ${data.videoTitle} ${versionName(data)} at ${rate} fps` +
        (owned.length ? `, replacing ${owned.length} from the last sync.` : '.'),
    ];
    if (coloring.length < colorByKey.size) {
      lines.push(
        `Could not find ${colorByKey.size - coloring.length} new marker(s) again to color them.`
      );
    }
    setStatus(lines.join('\n'), coloring.length < colorByKey.size);
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    button.disabled = false;
  }
}

$('link').addEventListener('change', onLinkChange);
$('load').addEventListener('click', loadVersions);
$('sync').addEventListener('click', syncMarkers);
$('link').value = localStorage.getItem('openframe.link') ?? '';
onLinkChange();
