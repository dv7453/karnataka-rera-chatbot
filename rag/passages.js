/**
 * Build one retrieval passage per RERA project.
 * No chunking — each row is already shorter than a typical embedding window.
 */

function decodeHtml(text) {
  return String(text || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function statusPhrase(project) {
  const status = String(project.status || 'Unknown').trim() || 'Unknown';
  const reg = String(project.rera_reg_no || '');
  if (/^PRM/i.test(reg)) return `${status} (registered)`;
  if (/^ACK/i.test(reg)) return `${status} (application)`;
  return status;
}

function buildPassage(project) {
  const name = decodeHtml(project.project_name) || 'Unknown project';
  const promoter = decodeHtml(project.promoter_name) || 'Unknown promoter';
  const reg = String(project.rera_reg_no || '').trim() || 'unknown';

  return [
    'Karnataka RERA project.',
    `Project name: ${name}`,
    `Promoter / builder / developer / company: ${promoter}`,
    `Registration number: ${reg}`,
    `Status: ${statusPhrase(project)}`,
  ].join('\n');
}

module.exports = {
  decodeHtml,
  buildPassage,
};
