/**
 * One-shot setup helpers.
 * Run from the Apps Script editor (or via Apps Script API) after first `clasp push`.
 *
 * DO NOT commit real values — always pass them as arguments.
 */

/**
 * Sets a batch of Script Properties. Safe to rerun.
 * @param {Object} props Map of key → value
 */
function setScriptProperties(props) {
  if (!props || typeof props !== 'object') {
    throw new Error('Expected props object');
  }
  PropertiesService.getScriptProperties().setProperties(props);
  return { ok: true, keys: Object.keys(props) };
}

/**
 * Returns which property keys are currently set (values not returned).
 */
function listScriptPropertyKeys() {
  var all = PropertiesService.getScriptProperties().getProperties();
  return { keys: Object.keys(all) };
}

/**
 * Full first-time bootstrap:
 *  - Sets script properties (call setScriptProperties beforehand)
 *  - Seeds stocks + categories
 *  - Sets up time-driven triggers
 * Usage from editor:
 *   1) setScriptProperties({FIREBASE_PROJECT_ID: '...', TG_BOT_TOKEN: '...', ...})
 *   2) bootstrap()
 */
function bootstrap() {
  var report = { ok: true };
  try { seedAll(); report.seed = 'ok'; } catch (err) { report.seed = String(err); }
  try { setupTriggers(); report.triggers = 'ok'; } catch (err) { report.triggers = String(err); }
  return report;
}
