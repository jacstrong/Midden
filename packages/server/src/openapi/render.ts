/** Render the OpenAPI document as the Markdown reference page in docs/. */

interface Schema {
  $ref?: string;
  type?: string | string[];
  enum?: unknown[];
  const?: unknown;
  items?: Schema;
  anyOf?: Schema[];
  oneOf?: Schema[];
  properties?: Record<string, Schema>;
  required?: string[];
  description?: string;
  default?: unknown;
  additionalProperties?: Schema | boolean;
  format?: string;
}

interface Parameter {
  name: string;
  in: string;
  required: boolean;
  description?: string;
  schema: Schema;
}

interface Operation {
  tags: string[];
  summary: string;
  description?: string;
  'x-midden-token': 'open' | 'read' | 'write' | 'none';
  parameters?: Parameter[];
  requestBody?: { content: Record<string, { schema: Schema }> };
  responses: Record<string, { description: string; content?: Record<string, { schema?: Schema }> }>;
}

interface Document {
  info: { version: string };
  tags: Array<{ name: string; description: string }>;
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, Schema> };
}

const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
const anchor = (name: string): string => `#${name.toLowerCase()}`;

/** A short human name for a schema's type. */
function typeName(s: Schema): string {
  if (s.$ref) {
    const name = s.$ref.split('/').at(-1)!;
    return `[${name}](${anchor(name)})`;
  }
  if (s.enum) return s.enum.map((v) => `\`${String(v)}\``).join(', ');
  if (s.const !== undefined) return `\`${JSON.stringify(s.const)}\``;
  const variants = s.anyOf ?? s.oneOf;
  if (variants) return variants.map(typeName).join(' or ');
  if (s.type === 'array') return `array of ${s.items ? typeName(s.items) : 'anything'}`;
  if (s.type === 'object' && s.additionalProperties && typeof s.additionalProperties === 'object')
    return `map to ${typeName(s.additionalProperties)}`;
  if (s.format === 'binary') return 'file';
  if (Array.isArray(s.type)) return s.type.join(' or ');
  return s.type ?? 'anything';
}

function fieldTable(s: Schema): string {
  const props = Object.entries(s.properties ?? {});
  if (!props.length) return '';
  const rows = props.map(([name, p]) => {
    const req = s.required?.includes(name) ? 'yes' : '';
    const note = [
      p.description ?? '',
      p.default !== undefined && p.default !== ''
        ? `Default \`${JSON.stringify(p.default)}\`.`
        : '',
    ]
      .filter(Boolean)
      .join(' ');
    return `| \`${name}\` | ${cell(typeName(p))} | ${req} | ${cell(note)} |`;
  });
  return ['| Field | Type | Required | Notes |', '| --- | --- | --- | --- |', ...rows].join('\n');
}

function schemaBlock(s: Schema): string {
  if (s.$ref) return typeName(s);
  return fieldTable(s) || typeName(s);
}

const TOKEN_LABEL: Record<Operation['x-midden-token'], string> = {
  open: 'No sign-in needed.',
  read: 'Any API token, or a session.',
  write: 'A write token, or a session.',
  none: 'A signed-in session only; API tokens are refused.',
};

export function renderReference(input: unknown): string {
  const doc = input as Document;
  const out: string[] = [
    '# API reference',
    '',
    '<!-- Generated from the server by `pnpm docs:api`. Edit packages/server/src/openapi/spec.ts, not this file. -->',
    '',
    `Every endpoint in version ${doc.info.version} of the Midden API, generated from the same schemas the server validates with. Start with the [API guide](api.md) for authentication and conventions. The machine-readable version is served at \`/api/openapi.json\`.`,
    '',
  ];

  for (const tag of doc.tags) {
    out.push(`## ${tag.name}`, '', tag.description, '');
    for (const [path, ops] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(ops)) {
        if (!op.tags.includes(tag.name)) continue;
        out.push(`### \`${method.toUpperCase()} ${path}\``, '', `${op.summary}.`, '');
        if (op.description) out.push(op.description, '');
        out.push(`**Access:** ${TOKEN_LABEL[op['x-midden-token']]}`, '');

        const params = (op.parameters ?? []).filter((p) => p.in === 'query');
        if (params.length) {
          out.push('**Query**', '', '| Name | Type | Notes |', '| --- | --- | --- |');
          for (const p of params) {
            const note = [
              p.description ?? '',
              p.schema.default !== undefined
                ? `Default \`${JSON.stringify(p.schema.default)}\`.`
                : '',
            ]
              .filter(Boolean)
              .join(' ');
            out.push(`| \`${p.name}\` | ${cell(typeName(p.schema))} | ${cell(note)} |`);
          }
          out.push('');
        }
        for (const [type, media] of Object.entries(op.requestBody?.content ?? {}))
          out.push(`**Body** (\`${type}\`)`, '', schemaBlock(media.schema), '');

        for (const [status, res] of Object.entries(op.responses)) {
          if (status === 'default') continue;
          const [type, media] = Object.entries(res.content ?? {})[0] ?? [];
          if (media?.schema) out.push(`**${status}**`, '', schemaBlock(media.schema), '');
          else out.push(`**${status}**${type ? ` (\`${type}\`)` : ''}: ${res.description}`, '');
        }
      }
    }
  }

  out.push('## Schemas', '');
  for (const [name, schema] of Object.entries(doc.components.schemas)) {
    out.push(`### ${name}`, '');
    if (schema.description) out.push(schema.description, '');
    if (name === 'Op') {
      out.push(
        'One change to a case. The `type` field picks the shape; see `OpSchema` in [`packages/core/src/ops/ops.ts`](../packages/core/src/ops/ops.ts) and the `Op` schema in `/api/openapi.json`.',
        '',
        (schema.oneOf ?? schema.anyOf ?? [])
          .map((o) => `\`${String(o.properties?.type?.const ?? '')}\``)
          .join(', '),
        '',
      );
      continue;
    }
    out.push(schemaBlock(schema), '');
  }
  return (
    out
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trimEnd() + '\n'
  );
}
