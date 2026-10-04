// The newest release of each editor plugin. The export API sends these with every
// marker sync, and a plugin older than its entry tells the editor to download it
// again. Raise an entry together with the plugin's own version: the unit tests check
// that the Premiere manifest and the Resolve script match.
export const EDITOR_PLUGIN_VERSIONS = {
  premiere: '0.1.0',
  resolve: '0.1.0',
} as const;
