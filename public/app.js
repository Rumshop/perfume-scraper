async function upload() {
  const file = document.getElementById("file").files[0];

  const form = new FormData();
  form.append("file", file);

  await fetch("/upload", {
    method: "POST",
    body: form,
  });

  poll();
}

function poll() {
  setInterval(async () => {
    const res = await fetch("/progress");
    const data = await res.json();

    document.getElementById("bar").style.width = data.progress + "%";
    document.getElementById("text").innerText = data.progress + "% done";
  }, 1000);
}