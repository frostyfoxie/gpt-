const MAX_FILES = 400;
const MAX_FILE_BYTES = 1.5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 12 * 1024 * 1024;

function safeRelativePath(input) {
  const raw = String(input ?? '');
  if (!raw || raw.includes('\0')) throw new Error('A file path is empty or contains a NUL byte.');

  // Normalize Windows separators before validation so traversal cannot hide in
  // backslash variants or mixed separators.
  const normalized = raw.replace(/\\/g, '/');

  // Client paths are always relative to the isolated workspace.
  if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) {
    throw new Error(`Absolute file paths are not allowed: ${raw}`);
  }

  const segments = normalized.split('/');
  if (segments.some((segment) => segment === '..')) {
    throw new Error(`Path traversal is not allowed: ${raw}`);
  }

  const cleaned = segments.filter((segment) => segment !== '' && segment !== '.').join('/');
  if (cleaned.split('/').some((segment) => /[\x00-\x1f\x7f]/.test(segment))) {
    throw new Error(`Path contains control characters: ${raw}`);
  }
  if (cleaned.split('/').some((segment) => segment.length > 255)) {
    throw new Error(`Path segment is too long: ${raw}`);
  }
  if (cleaned.split('/').some((segment) => /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i.test(segment))) {
    throw new Error(`Reserved filename is not allowed: ${raw}`);
  }
  if (!cleaned || cleaned === '.') throw new Error('A file path is empty.');

  return cleaned;
}

function safeFiles(input) {
  if (!Array.isArray(input) || input.length > MAX_FILES) {
    throw new Error(`Too many files (max ${MAX_FILES}).`);
  }

  let total = 0;
  const seen = new Set();
  return input.map((file) => {
    const path = safeRelativePath(file?.path);
    if (seen.has(path)) throw new Error(`Duplicate file path: ${path}`);
    seen.add(path);
    const content = String(file?.content ?? '');
    const bytes = Buffer.byteLength(content, 'utf8');

    if (bytes > MAX_FILE_BYTES) throw new Error(`File too large: ${path}`);
    total += bytes;
    if (total > MAX_TOTAL_BYTES) {
      throw new Error('Project payload is too large for the execution API.');
    }

    return { path, content };
  });
}

export { MAX_FILES, MAX_FILE_BYTES, MAX_TOTAL_BYTES, safeRelativePath, safeFiles };
