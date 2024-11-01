const open_elems = document.querySelectorAll("[data-open]");
const close_elems = document.querySelectorAll("[data-close]");

for(const elem of open_elems) {
  elem.addEventListener("click", function() {
    identifier = elem.getAttribute("data-open")
    document.getElementById(identifier).classList.add("is-visible");
  });
}

for (const elem of close_elems) {
  elem.addEventListener("click", function() {
    this.parentElement.parentElement.parentElement.classList.remove("is-visible");
  });
}

document.addEventListener("click", e => {
  if (e.target == document.querySelector(".modal.is-visible")) {
    document.querySelector(".modal.is-visible").classList.remove("is-visible");
  }
});

document.addEventListener("keyup", e => {
  if (e.key == "Escape" && document.querySelector(".modal.is-visible")) {
    document.querySelector(".modal.is-visible").classList.remove("is-visible");
  }
});
