async function uploadFile() {
  const file = document.getElementById("fileInput").files[0];

  if (!file) {
    alert("Select a file first");
    return;
  }

  const formData = new FormData();
  formData.append("file", file);

  document.getElementById("status").innerText = "Processing... ⏳";

  const res = await fetch("/upload-csv-ui", {
    method: "POST",
    body: formData
  });

  const data = await res.json();

  document.getElementById("status").innerText = "Done ✅";

  document.getElementById("downloadLink").style.display = "block";

  renderTable(data.results);
}

function renderTable(data) {
  const tbody = document.getElementById("tableBody");
  tbody.innerHTML = "";

  data.forEach(row => {
    const tr = document.createElement("tr");

    tr.innerHTML = `
      <td>${row.product}</td>
      <td>${row.heinemann_price}</td>
      <td>${row.size}</td>
      <td>${row.type}</td>
      <td>${row.cheapest_store}</td>
    `;

    tbody.appendChild(tr);
  });
}