import { basicSetup } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { EditorView, placeholder } from '@codemirror/view';
import { unfoldAll } from '@codemirror/language';
import { json } from '@codemirror/lang-json';

// File loading and clipboard access use browser JavaScript; calculation uses a normal HTML form.
const zone = document.querySelector('#drop-zone');
const input = document.querySelector('#input');
const status = document.querySelector('#file-status');
const submit = document.querySelector('button[type="submit"]');

const output = document.querySelector('#output');
const styleNonce = document.querySelector('meta[name="editor-style-nonce"]').content;

/** Enhance a textarea while retaining its complete value for forms and downloads.
 * @param {HTMLTextAreaElement} textarea @param {boolean} readOnly
 * @returns {EditorView}
 */
function createEditor(textarea, readOnly) {
  const mount = document.createElement('div');
  mount.className = 'calculator-editor';
  textarea.before(mount);
  const view = new EditorView({
    parent: mount,
    doc: textarea.value,
    extensions: [
      basicSetup, json(), EditorView.lineWrapping,
      EditorView.cspNonce.of(styleNonce),
      EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly),
      EditorView.contentAttributes.of({
        'aria-labelledby': `${textarea.id}-label`,
        'aria-readonly': String(readOnly), tabindex: '0',
      }),
      placeholder(readOnly ? 'Your JSON result will appear here.' : 'Paste calculator input here'),
      EditorView.updateListener.of(update => {
        if (update.docChanged) textarea.value = update.state.doc.toString();
      }),
    ],
  });
  textarea.hidden = true;
  textarea.required = false;
  document.querySelector(`label[for="${textarea.id}"]`).addEventListener('click', () => view.focus());
  return view;
}
const inputEditor = createEditor(input, false);
const outputEditor = createEditor(output, true);
input.form.addEventListener('submit', event => {
  input.value = inputEditor.state.doc.toString();
  if (!input.value.trim()) {
    event.preventDefault();
    status.textContent = 'Supply JSON input before calculating.';
    inputEditor.focus();
  }
});


/** Load a dropped file into the editable input. @param {File} file */
async function loadFile(file) {
  submit.disabled = true;
  try {
    if (file.size > 1024 * 1024) throw new Error('Please choose a JSON file no larger than 1 MiB.');
    let text = await file.text();
    try { text = JSON.stringify(JSON.parse(text), null, 2); } catch { /* Keep malformed JSON editable. */ }
    inputEditor.dispatch({ changes: { from: 0, to: inputEditor.state.doc.length, insert: text } });
    status.textContent = `Loaded ${file.name}. Choose its calculator and submit.`;
  } catch (error) {
    status.textContent = error.message;
  } finally {
    submit.disabled = false;
  }
}
zone.addEventListener('dragover', event => {
  event.preventDefault();
  zone.classList.add('dragging');
});
zone.addEventListener('dragleave', () => zone.classList.remove('dragging'));
zone.addEventListener('drop', event => {
  if (!event.dataTransfer.files.length) return;
  event.preventDefault();
  event.stopPropagation();
  zone.classList.remove('dragging');
  if (event.dataTransfer.files.length !== 1) {
    status.textContent = 'Drop one JSON file at a time.';
    return;
  }
  loadFile(event.dataTransfer.files[0]);
}, { capture: true });

const copyButton = document.querySelector('#copy-output');
const copyStatus = document.querySelector('#copy-status');

/** Copy the complete output, with a selection-based fallback for plain HTTP. */
async function copyOutput() {
  let copied = false;
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(output.value);
      copied = true;
    } catch {
      // Clipboard permission may be denied; try the user-initiated fallback.
    }
  }
  if (!copied) {
    output.hidden = false;
    output.classList.add('clipboard-source');
    output.focus();
    output.select();
    try {
      copied = document.execCommand('copy');
    } catch {
      copied = false;
    } finally {
      output.hidden = true;
      output.classList.remove('clipboard-source');
    }
  }
  if (copied) {
    copyButton.focus();
    copyStatus.textContent = 'Output copied to clipboard.';
  } else {
    unfoldAll(outputEditor);
    outputEditor.dispatch({ selection: { anchor: 0, head: outputEditor.state.doc.length } });
    outputEditor.focus();
    copyStatus.textContent = 'Copy was blocked. The output is selected; press Ctrl+C or Command+C to copy.';
  }
}
copyButton.addEventListener('click', copyOutput);


/** Download the displayed result as a local JSON file. */
function saveOutput() {
  const file = new Blob([output.value, '\n'], { type: 'application/json' });
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url;
  link.download = output.dataset.filename;
  document.body.append(link);
  link.click();
  link.remove();
  // Allow the browser to begin the download before releasing the object URL.
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
document.querySelector('#save-output').addEventListener('click', saveOutput);
