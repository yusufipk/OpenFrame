const ppro = require('premierepro');
const { storage } = require('uxp');
const {
  chunks,
  errorMessage,
  framesToTicks,
  acceptedEntries,
  isOpenFrameMarker,
  markerComments,
  markerKey,
  ownsMarker,
  parseVideoLink,
  rateFromTimebase,
  sendSummary,
  ticksToFrames,
  tokenKey,
  updateNotice,
  versionName,
} = require('./markers.js');

const BATCH = 50;
// The most markers the server takes in one request.
const SEND_BATCH = 500;
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
  $('send').disabled = true;
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

async function api(origin, path, body) {
  const headers = { Authorization: `Bearer ${$('token').value.trim()}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${origin}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const reply = await response.json().catch(() => null);
  if (!response.ok) throw new Error(errorMessage(response.status, reply));
  return reply.data;
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
    $('send').disabled = video.versions.length === 0;
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

// The link, the picked version and the open sequence with its frame rate.
async function target() {
  const link = readLink();
  const versionId = $('version').value;
  if (!versionId) throw new Error('Load the versions and pick one.');
  const project = await ppro.Project.getActiveProject();
  const sequence = project && (await project.getActiveSequence());
  if (!sequence) throw new Error('Open a sequence in the timeline first.');
  const rate = rateFromTimebase(await sequence.getTimebase());
  if (!rate) throw new Error('This sequence frame rate is not supported.');
  return { link, versionId, project, sequence, rate };
}

async function syncMarkers() {
  const button = $('sync');
  button.disabled = true;
  try {
    const { link, versionId, project, sequence, rate } = await target();
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
    const notice = updateNotice(data.pluginVersions);
    if (notice) lines.push(notice);
    setStatus(lines.join('\n'), coloring.length < colorByKey.size);
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    button.disabled = false;
  }
}

// Sends the editor's own markers on the sequence to the picked version as comments.
// Every marker the server took is then tagged like a synced one, so the next sync
// swaps it for the OpenFrame copy and the next send leaves it out.
async function sendMarkers() {
  const button = $('send');
  button.disabled = true;
  try {
    const { link, versionId, project, sequence, rate } = await target();
    const markers = await ppro.Markers.getMarkers(sequence);
    const own = [];
    for (const marker of markers.getMarkers()) {
      // Chapter, web link and other special markers are not review notes.
      if (typeof marker.getType === 'function') {
        if ((await marker.getType()) !== ppro.Marker.MARKER_TYPE_COMMENT) continue;
      }
      const comments = (await marker.getComments()) ?? '';
      if (isOpenFrameMarker(comments)) continue;
      const start = await marker.getStart();
      const duration = await marker.getDuration();
      own.push({
        marker,
        comments,
        payload: {
          startFrame: ticksToFrames(start.ticks, rate),
          durationFrames: duration ? ticksToFrames(duration.ticks, rate) : 0,
          name: (await marker.getName()) ?? '',
          comments,
        },
      });
    }
    if (own.length === 0) throw new Error('This sequence has no markers of your own to send.');

    setStatus('Sending markers…');
    const total = { created: 0, duplicates: 0, skipped: { empty: 0, outOfRange: 0, tooLong: 0 } };
    const accepted = [];
    let pluginVersions;
    // A failed batch stops the send, but the batches before it are already comments,
    // so their markers are still tagged below rather than left to double on the next sync.
    let sendError = null;
    let sent = 0;
    for (const batch of chunks(own, SEND_BATCH)) {
      let data;
      try {
        data = await api(
          link.origin,
          `/api/versions/${encodeURIComponent(versionId)}/comments/import`,
          { fps: rate, markers: batch.map((entry) => entry.payload) }
        );
      } catch (error) {
        sendError = error;
        break;
      }
      total.created += data.created;
      total.duplicates += data.duplicates;
      for (const reason of Object.keys(total.skipped)) {
        total.skipped[reason] += (data.skipped && data.skipped[reason]) || 0;
      }
      accepted.push(...acceptedEntries(batch, data.accepted));
      pluginVersions = data.pluginVersions;
      sent += batch.length;
    }
    if (sendError && accepted.length === 0) throw sendError;

    const lines = sendSummary(total, sent);
    const taggable = accepted.filter(
      (entry) => typeof entry.marker.createSetCommentsAction === 'function'
    );
    let tagged = true;
    try {
      for (const group of chunks(taggable, BATCH)) {
        runTransaction(project, 'Mark markers as sent to OpenFrame', (compound) => {
          for (const entry of group) {
            compound.addAction(
              entry.marker.createSetCommentsAction(
                markerComments({ comments: entry.comments }, versionId)
              )
            );
          }
        });
      }
    } catch (error) {
      tagged = false;
      lines.push(
        sendError
          ? error.message
          : `${error.message} Sending again will not add the comments twice.`
      );
    }
    if (tagged && taggable.length < accepted.length) {
      lines.push(
        'This Premiere version cannot edit marker comments, so the sent markers stay as they are. Delete them before the next sync to avoid doubles.'
      );
    } else if (tagged && accepted.length) {
      lines.push(
        'The next sync of this version replaces the sent markers with the OpenFrame comments.'
      );
    }
    if (sendError) {
      lines.push(
        `${sendError.message} The rest was not sent; sending again will not add the comments twice.`
      );
    }
    const notice = updateNotice(pluginVersions);
    if (notice) lines.push(notice);
    setStatus(lines.join('\n'), !tagged || Boolean(sendError));
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    button.disabled = false;
  }
}

// Resolved comments stay off the timeline unless asked for, and the choice sticks.
$('resolved').checked = localStorage.getItem('openframe.includeResolved') === 'true';
$('resolved').addEventListener('change', () =>
  localStorage.setItem('openframe.includeResolved', String($('resolved').checked))
);
$('link').addEventListener('change', onLinkChange);
$('load').addEventListener('click', loadVersions);
$('sync').addEventListener('click', syncMarkers);
$('send').addEventListener('click', sendMarkers);
$('link').value = localStorage.getItem('openframe.link') ?? '';
onLinkChange();
