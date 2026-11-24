/**
 * RFC 4180 CSV, written by hand so the playbook format adds nothing to the SBOM. Shared by the
 * server import and the browser's preview, so both read a file exactly the same way.
 */

export interface CsvRow {
  /** 1-based line where the row starts, for error messages. */
  line: number;
  cells: string[];
}

/** Parse CSV text. Accepts a BOM, CRLF/LF/CR line endings and quoted fields with newlines. */
export function parseCsv(text: string): CsvRow[] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: CsvRow[] = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  let line = 1;
  let rowLine = 1;
  let i = 0;
  // Whether the current row has any content yet, so a trailing newline doesn't add a row.
  let started = false;

  const endCell = (): void => {
    cells.push(cell);
    cell = '';
  };
  const endRow = (): void => {
    endCell();
    if (started) rows.push({ line: rowLine, cells });
    cells = [];
    started = false;
  };

  while (i < src.length) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      if (ch === '\n' || (ch === '\r' && src[i + 1] !== '\n')) line++;
      cell += ch;
      i++;
      continue;
    }
    if (ch === '"' && cell === '') {
      quoted = true;
      started = true;
      i++;
      continue;
    }
    if (ch === ',') {
      started = true;
      endCell();
      i++;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      endRow();
      i += ch === '\r' && src[i + 1] === '\n' ? 2 : 1;
      line++;
      rowLine = line;
      continue;
    }
    started = true;
    cell += ch;
    i++;
  }
  if (quoted || started || cell !== '' || cells.length) endRow();
  return rows;
}

/** Characters that make a spreadsheet treat a cell as a formula. */
const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * Prefix cells a spreadsheet would run as a formula with `'`, so an exported title like
 * `=HYPERLINK(...)` stays text. `unguardCell` reverses it on import.
 */
export function guardCell(value: string): string {
  return FORMULA_START.test(value) ? `'${value}` : value;
}

export function unguardCell(value: string): string {
  return value.startsWith("'") && FORMULA_START.test(value.slice(1)) ? value.slice(1) : value;
}

function quoteCell(value: string): string {
  return /[",\r\n]/.test(value) || /^\s|\s$/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function writeCsv(
  rows: readonly (readonly string[])[],
  opts: { guard?: boolean } = {},
): string {
  const guard = opts.guard ?? true;
  return rows
    .map((r) => r.map((c) => quoteCell(guard ? guardCell(c) : c)).join(','))
    .join('\r\n')
    .concat('\r\n');
}

/**
 * List cells (assignees, labels, checklist) separate items with `;`. A literal `;` or `\` in an
 * item is escaped with a backslash.
 */
export function splitList(cell: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < cell.length; i++) {
    const ch = cell[i]!;
    if (ch === '\\' && (cell[i + 1] === ';' || cell[i + 1] === '\\')) {
      cur += cell[i + 1];
      i++;
    } else if (ch === ';') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

export function joinList(items: readonly string[]): string {
  return items.map((s) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;')).join('; ');
}
