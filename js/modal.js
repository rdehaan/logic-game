// The info pop-ups that the (i) buttons open: native dialogs (docs/modals.html).
// showModal() moves the focus into the dialog and keeps it there, and Escape
// closes it; when it closes, the focus goes back to the button that opened it.
// (One listener for the whole page, so that it also works for buttons and
// pop-ups that are loaded later, see load_fragments in main.js.)

let opener = null;      // the element that had the focus when a dialog was opened

document.addEventListener('click', (e) => {
  const open = e.target.closest('[data-open]');
  if (open) {
    e.preventDefault();
    const dialog = document.getElementById(open.dataset.open);
    if (dialog && !dialog.open) {
      opener = open;
      dialog.showModal();
    }
    return;
  }
  const close = e.target.closest('[data-close]');
  if (close) {
    const dialog = close.closest('dialog');
    if (dialog) dialog.close();
    return;
  }
  // A click next to the pop-up (on the backdrop: the dialog element itself, around
  // its content) closes it
  if (e.target instanceof HTMLDialogElement && e.target.classList.contains('modal') && e.target.open) {
    e.target.close();
  }
});

// (also after Escape, which closes a dialog by itself)
document.addEventListener('close', (e) => {
  if (!(e.target instanceof HTMLDialogElement) || !e.target.classList.contains('modal')) return;
  if (opener && opener.isConnected) opener.focus();
  opener = null;
}, true);
