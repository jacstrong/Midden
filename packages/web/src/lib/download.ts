/** Browser file helpers: download a blob, or write back to the file the case was opened from. */

export function downloadText(
  name: string,
  text: string,
  mime = 'application/json;charset=utf-8',
): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

type SaveHandle = FileSystemFileHandle & {
  createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void> }>;
};

/** Overwrite the file in place when the File System Access API is available; false otherwise. */
export async function writeBack(
  handle: FileSystemFileHandle | null,
  text: string,
): Promise<boolean> {
  if (!handle || typeof (handle as SaveHandle).createWritable !== 'function') return false;
  try {
    const w = await (handle as SaveHandle).createWritable();
    await w.write(text);
    await w.close();
    return true;
  } catch {
    return false;
  }
}

export interface PickedFile {
  file: File;
  handle: FileSystemFileHandle | null;
}

type Picker = (opts: {
  types: Array<{ description: string; accept: Record<string, string[]> }>;
  multiple: false;
}) => Promise<FileSystemFileHandle[]>;

/** Open a file, preferring the File System Access picker so we can save back later. */
export async function pickFile(
  accept: Record<string, string[]>,
  description: string,
  fallbackInput: HTMLInputElement | null,
): Promise<PickedFile | null> {
  const picker = (window as unknown as { showOpenFilePicker?: Picker }).showOpenFilePicker;
  if (picker) {
    try {
      const [handle] = await picker.call(window, {
        types: [{ description, accept }],
        multiple: false,
      });
      if (!handle) return null;
      return { file: await handle.getFile(), handle };
    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError') return null;
      // fall through to the input element
    }
  }
  if (!fallbackInput) return null;
  return new Promise((resolve) => {
    fallbackInput.value = '';
    fallbackInput.onchange = () => {
      const f = fallbackInput.files?.[0];
      resolve(f ? { file: f, handle: null } : null);
    };
    fallbackInput.click();
  });
}
