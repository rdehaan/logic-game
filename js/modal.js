// The info pop-ups (modals) that the (i) links open.
// (One listener for the whole page, so that it also works for links and
// pop-ups that are loaded later, see load_fragments in main.js.)

document.addEventListener('click', (e) => {
  const open = e.target.closest('[data-open]');
  if (open) {
    e.preventDefault();
    const modal = document.getElementById(open.dataset.open);
    if (modal) modal.classList.add('is-visible');
    return;
  }
  const close = e.target.closest('[data-close]');
  if (close) {
    const modal = close.closest('.modal');
    if (modal) modal.classList.remove('is-visible');
    return;
  }
  // A click next to the pop-up closes it
  if (e.target.classList.contains('modal') && e.target.classList.contains('is-visible')) {
    e.target.classList.remove('is-visible');
  }
});

document.addEventListener('keyup', (e) => {
  const visible = document.querySelector('.modal.is-visible');
  if (e.key === 'Escape' && visible) visible.classList.remove('is-visible');
});
