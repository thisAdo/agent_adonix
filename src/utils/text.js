const { MAX_OUTPUT_CHARS } = require('../config');

function shortText(value, limit = 90) {
  if (!value) {
    return '';
  }

  const text = String(value).replace(/\s+/g, ' ').trim();
  if (text.length <= limit) {
    return text;
  }

  return `${text.slice(0, limit - 3)}...`;
}

function normalizeText(value) {
  if (typeof value !== 'string') {
    return '';
  }

  let trimmed = value.trim();

  if (trimmed.startsWith('```')) {
    trimmed = trimmed
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();
  }

  if (trimmed.startsWith('`') && trimmed.endsWith('`') && !trimmed.startsWith('``')) {
    trimmed = trimmed.slice(1, -1).trim();
  }

  return trimmed;
}

function truncateText(value, limit = MAX_OUTPUT_CHARS) {
  if (value.length <= limit) {
    return value;
  }

  return `${value.slice(0, limit)}\n\n[truncado: ${value.length - limit} caracteres omitidos]`;
}

function formatLineRange(lines, startLine, endLine) {
  return lines
    .slice(startLine - 1, endLine)
    .map((line, index) => `${startLine + index}. ${line}`)
    .join('\n');
}

module.exports = {
  formatLineRange,
  normalizeText,
  shortText,
  truncateText,
};
