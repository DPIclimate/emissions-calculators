// File loading and clipboard access use browser JavaScript; calculation uses a normal HTML form.
const zone = document.querySelector('#drop-zone');
const fileInput = document.querySelector('#file');
const input = document.querySelector('#input');
const status = document.querySelector('#file-status');
const submit = document.querySelector('button[type="submit"]');

/** Load a selected or dropped file into the editable input. @param {File} file */
async function loadFile(file) {
  submit.disabled = true;
  try {
    if (file.size > 1024 * 1024) throw new Error('Please choose a JSON file no larger than 1 MiB.');
    input.value = await file.text();
    status.textContent = `Loaded ${file.name}. Choose its calculator and submit.`;
  } catch (error) {
    status.textContent = error.message;
  } finally {
    submit.disabled = false;
  }
}
fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) loadFile(fileInput.files[0]);
});
zone.addEventListener('dragover', event => {
  event.preventDefault();
  zone.classList.add('dragging');
});
zone.addEventListener('dragleave', () => zone.classList.remove('dragging'));
zone.addEventListener('drop', event => {
  event.preventDefault();
  zone.classList.remove('dragging');
  if (event.dataTransfer.files.length !== 1) {
    status.textContent = 'Drop one JSON file at a time.';
    return;
  }
  loadFile(event.dataTransfer.files[0]);
});

const output = document.querySelector('#output');
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
    output.focus();
    output.select();
    try {
      copied = document.execCommand('copy');
    } catch {
      copied = false;
    }
  }
  if (copied) {
    copyButton.focus();
    copyStatus.textContent = 'Output copied to clipboard.';
  } else {
    output.focus();
    output.select();
    copyStatus.textContent = 'Copy was blocked. The output is selected; press Ctrl+C or Command+C to copy.';
  }
}
copyButton.addEventListener('click', copyOutput);
