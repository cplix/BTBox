
/*
=========================================================
BT BOX – PROCESS STATUS APP
=========================================================

OVERVIEW:
This application visualizes the production status of a product
(Bluetooth Box) including:
- CAD data (Fusion export JSONs)
- CNC machine live data
- 3D printer live data
- Manual workflow steps (Firestore)

DATA SOURCES:
- data/{group}/grp_xxx.json → configuration (manufacturing, links)
- data/{group}/cad/*.json → CAD exports (multi-component capable)
- data/{group}/cnc/*.json → CNC live data
- data/{group}/3dprint/*.json → printer live data

CORE FLOW:
1. Read group ID from URL
2. Load all data sources (loadAllSources)
3. Render product data cards (CAD, CNC, 3D)
4. Initialize Firestore steps
5. Listen to step updates in realtime

DESIGN PRINCIPLES:
- Resilient loading (Promise.allSettled)
- Modular rendering (separate render functions)
- Clear separation: data vs UI

=========================================================
*/
const firebaseConfig = {
  apiKey: "AIzaSyAf4taN1T3l75PHuoTc-5Y4T62ED2Om1TA",
  authDomain: "i40-btbox.firebaseapp.com",
  projectId: "i40-btbox"
};

//Dateiname zentral hier anpassen
const FILES = {
  cnc: "cnc_statemonitor.json",
  print: "3dp_prusalink.json"
};


firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();

// 🔥 Stabiler Firestore Transport (GitHub Pages kompatibel)
db.settings({
  experimentalForceLongPolling: true,
  useFetchStreams: false
});

// 🔕 Reduziere Firestore Konsole-Noise
firebase.firestore.setLogLevel('error');

window.addEventListener('load', () => {
  console.log("Firestore long-polling fix active");
});

const id = new URLSearchParams(window.location.search).get("id");

if (!id) {
  document.body.innerHTML = "❌ Keine Gruppen-ID angegeben";
  throw new Error("Missing id");
}

let role = null;
let selectedCadIndex = 0;
let cachedSources = null;
const contentDiv = document.getElementById("content");

const stepOrder = [
  "Konstruktion","Fertigung","Vormontage","Endmontage","Endabnahme"
];

const subStepsConfig = {

  "Konstruktion": [
    { id:"k_01", label:"3D-Modell" },
    { id:"k_02", label:"Zusammenbau" },
    { id:"k_03", label:"Technische Dokumente" }
  ],

  "Fertigung": [
    { id:"f_01", label:"3D-Druck" },
    { id:"f_02", label:"CNC-Bearbeitung" }
  ],

  "Vormontage": [
    { id:"vm_01", label:"Komponenten/Material vollständig" },
    { id:"vm_02", label:"Montage auf Montageplatte" },
    { id:"vm_03", label:"Elektrische Anschlussarbeiten" },
    { id:"vm_04", label:"Funktionskontrolle" }
  ],

  "Endmontage": [
    { id:"em_01", label:"Montage auf Komponentenplatine" },
    { id:"em_02", label:"Montage Gehäuse/Deckel" },
    { id:"em_03", label:"Elektrische Anschlussarbeiten" },
    { id:"em_04", label:"Funktionskontrolle 1" },
    { id:"em_05", label:"Zusammenbau" },
    { id:"em_06", label:"Funktionskontrolle 2" }
  ],

  "Endabnahme": [
    { id:"ea_01", label:"Funktionskontrolle" },
    { id:"ea_02", label:"Erscheinungsbild" },
    { id:"ea_03", label:"Freigabe" }
  ]
};

const displayConfig = {

  // 🔹 Basisdaten
  product_id: { show:true, label:"Produkt-ID", highlight:true },
  product_name: { show:false, label:"Produktname" },
  group_name: { show:false, label:"Gruppe" },
  version: { show:true, label:"" },

  // 🔹 Fertigung
  manufacturing: { show:true, label:"Fertigung" },
  "3d_print": { show:true, label:"3D-Druck" },
  cnc: { show:true, label:"CNC" },

  // 🔹 Details
  component: { show:true, label:"Einzelteil" },
  material: { show:true, label:"Material" },
  layer_height: { show:true, label:"Schichthöhe" },
  perimeter: { show:true, label:"Perimeter" },
  infill: { show:true, label:"Infill" },

  // 🔹 Links
  link: { show:true, label:"Links" },
  cad: { show:true, label:"CAD-Modell" }
};

const displayOrder = [
  "product_id",
  "version",
  "manufacturing",
  "link"
];

// =========================================================
// 🔧 HELPER FUNCTIONS
// =========================================================
function getLabel(key){
  return displayConfig[key]?.label ||
    key.replace(/_/g," ")
       .replace(/\b\w/g,l=>l.toUpperCase());
}

function isVisible(key){
  return displayConfig[key]?.show !== false;
}

function getStatus(step, allDone, stepId, allStepsData){

  const hasProgress = Object.values(step.substeps || {}).some(v => v);

  // 🔹 Endabnahme Sonderlogik (nur Freigabe abhängig von vorherigen Steps)
  if(stepId === "Endabnahme"){

    const readyForApproval = stepOrder
      .filter(s => s !== "Endabnahme")
      .every(s => {
        const st = allStepsData[s];
        if(!st) return false;
        const subs = st.substeps || {};
        const cfg = subStepsConfig[s] || [];
        return cfg.every(c => subs[c.id] === true);
      });

    if(allDone) return "done";
    if(readyForApproval) return "ready";
    if(hasProgress) return "progress";
    return "empty";
  }

  // 🔹 Standard (rein aus Substeps)
  if(allDone) return "done";
  if(hasProgress) return "progress";
  return "empty";
}

function getStatusBadge(status){

  if(status === "done"){
    return `<span class="badge badge-green">✔ bestanden</span>`;
  }

  if(status === "ready"){
    return `<span class="badge badge-yellow">bereit zur Prüfung</span>`;
  }

  if(status === "progress"){
    return `<span class="badge badge-blue">in Arbeit</span>`;
  }

  return `<span class="badge badge-red">nicht begonnen</span>`;
}

function showToast(message, type="success"){

  const toast = document.getElementById("toast");

  toast.className = `toast ${type}`;
  toast.innerText = message;

  // trigger animation
  setTimeout(()=>toast.classList.add("show"), 10);

  // auto hide
  setTimeout(()=>{
    toast.classList.remove("show");
  }, 2500);
}


function selectRole(r){
  role=r;
  document.getElementById("roleSelection").style.display="none";
  contentDiv.style.display="block";
  contentDiv.scrollIntoView({ behavior: "smooth" });
  startApp();
}


// =========================================================
// 📦 DATA LOADING FUNCTIONS
// =========================================================
async function loadProductName(){
  let productName = "Bluetooth-Box";
  let groupName = null;

  try {
    const res = await fetch(`data/${id}/${id}.json`);
    const json = await res.json();
    if (json.product_name) productName = json.product_name;
    if (json.group_name) groupName = json.group_name;
  } catch {}

  let html = `Produkt: <b>${productName} 🔊</b>`;
  if (groupName) html += `<br><small>Gruppe: ${groupName}</small>`;
  document.getElementById("productTitle").innerHTML = html;
}

function renderObject(obj, level = 0){

  let html = "";

  for(const key in obj){

    // 🔥 AUSBLENDEN
    if(!isVisible(key)) continue;

    const value = obj[key];
    const label = getLabel(key);

    if(typeof value === "object" && value !== null){

      html += `
        <div style="margin-left:${level*15}px; margin-top:6px;">
          <b>${label}</b><br>
          ${renderObject(value, level+1)}
        </div>
      `;

    } else {

      if(typeof value === "string" && value.startsWith("http")){

        html += `
          <div style="margin-left:${level*15}px;">
            ${label}: <a href="${value}" target="_blank">öffnen</a>
          </div>
        `;

      } else {

        html += `
          <div style="margin-left:${level*15}px;">
            ${label}: ${value}
          </div>
        `;

      }
    }
  }

  return html;
}


// =========================================================
// 🧩 RENDERING FUNCTIONS (UI)
// =========================================================
function renderProductCard(cadComponents, group){

  if(!cadComponents || cadComponents.length === 0){
    return `
      <div class="data-card">
        <div class="data-title">📦 Produkt</div>
        Keine CAD-Daten gefunden
      </div>
    `;
  }

  const cad = cadComponents[0];

  const imagePath = `data/${id}/product.png`;

  return `
    <div class="data-card">
      <div class="data-title">📦 Produkt</div>

      <div class="data-card-grid">

        <div>
          <b>${cad.productId}</b><br>
          ${cad.selectedComponent?.hinweis || "-"}
        </div>

        <div>
          ${group?.link?.cad
            ? `<a class="data-btn" href="${group.link.cad}" target="_blank">CAD öffnen</a>`
            : `<span class="data-btn" style="background:#bdc3c7;">kein CAD-Link</span>`
          }
        </div>

        <div class="data-image">
          <img src="${imagePath}" onerror="this.style.display='none'">
        </div>

      </div>
    </div>
  `;
}


function renderCadCards(cadComponents){

  if(!cadComponents || cadComponents.length === 0){
    return `<div class="data-card">Keine Komponenten</div>`;
  }

  const cad = cadComponents[selectedCadIndex] || cadComponents[0];
  const comp = cad.components?.[0];
  if(!comp) return "";

  const compName = comp.name || cad._meta?.name || "Unbekannt";
  const imagePath = `data/${id}/cad/${cad._meta.file.replace(".json",".png")}`;

  // 🔹 Build dropdown options
  const options = cadComponents.map((c, i) => {
    const name = c.components?.[0]?.name || c._meta?.name || `Komponente ${i+1}`;
    return `<option value="${i}" ${i===selectedCadIndex?"selected":""}>${name}</option>`;
  }).join("");

  return `
    <div class="data-card">
      <div class="data-title">🧩 CAD – ${compName}</div>

      <div style="margin-bottom:10px;">
        <select onchange="changeCadComponent(this.value)">
          ${options}
        </select>
      </div>

      <div class="data-card-grid">

        <div>
          ID: ${comp.componentId || "-"}<br>
          Hinweis: ${comp.hinweis || cad.selectedComponent?.hinweis || "-"}<br>
          Status: ${comp.cadStatus || cad.selectedComponent?.cadStatus || "-"}
        </div>

        <div>
          Material: ${(comp.materials || []).join(", ")}<br>
          Masse: ${comp.mass_g} g<br>
          Volumen: ${comp.volume_cm3} cm³<br>
          Hüllmaß: ${comp.boundingBox_mm
            ? `${comp.boundingBox_mm.length} × ${comp.boundingBox_mm.width} × ${comp.boundingBox_mm.height} mm`
            : "-"}<br>
          Export: ${cad.exportedAt 
            ? new Date(cad.exportedAt).toLocaleString("de-DE", { 
                dateStyle: "short", 
                timeStyle: "short" 
              }) 
            : "-"}
        </div>

        <div class="data-image">
          <img src="${imagePath}" onerror="this.style.display='none'">
        </div>

      </div>

    </div>
  `;
}


function renderCncCard(group, cnc){
  // 🔹 CNC card: left = configuration, right = live machine data
  const imagePath = `data/${id}/cnc/fusion_cnc.png`;
  return `
    <div class="data-card">
      <div class="data-title">⚙️ CNC</div>

      <div class="data-card-grid">

        <div class="data-block">
          <b>Vorgaben:</b><br>
          Bauteil: ${group?.manufacturing?.cnc?.component || "-"}<br>
          Maschine: ${group?.manufacturing?.cnc?.machine || "-"}<br>
          Material: ${group?.manufacturing?.cnc?.material || "-"}<br>
          Werkzeug: ${group?.manufacturing?.cnc?.tool || "-"}<br>
        </div>

        <div class="data-block">
          <b>Live:</b><br>
          Quelle: ${cnc?.source || "-"}<br>
          Steuerung: ${cnc?.control || "-"}<br>
          Drehzahl: ${cnc?.cnc?.speed || "-"}<br>
          Vorschub: ${cnc?.cnc?.feed || "-"}<br>
          Tool: ${cnc?.cnc?.tool || "-"}
        </div>

        <div class="data-image">
          <img src="${imagePath}" onerror="this.style.display='none'">
        </div>

      </div>
    </div>
  `;
}


function renderPrintCard(group, print){
  // 🔹 3D print card: left = slicing config, right = printer live data
  const imagePath = `data/${id}/3dprint/3dp-prusaslicer.png`;
  return `
    <div class="data-card">
      <div class="data-title">🖨️ 3D-Druck</div>

      <div class="data-card-grid">

        <div class="data-block">
          <b>Vorgaben:</b><br>
          Bauteil: ${group?.manufacturing?.["3d_print"]?.component || "-"}<br>
          Maschine: ${group?.manufacturing?.["3d_print"]?.machine || "-"}<br>
          Material: ${group?.manufacturing?.["3d_print"]?.material || "-"}<br>
          Schichthoehe: ${group?.manufacturing?.["3d_print"]?.layer_height || "-"}<br>
          Perimeter: ${group?.manufacturing?.["3d_print"]?.perimeter || "-"}<br>
          Infill: ${group?.manufacturing?.["3d_print"]?.infill || "-"}<br>
        </div>

        <div class="data-block">
          <b>Live:</b><br>
          Material: ${print?.print?.filament || "-"}<br>
          Schichthoehe: ${print?.print?.layer_height || "-"}<br>
          Infill: ${print?.print?.infill || "-"}
        </div>

        <div class="data-image">
          <img src="${imagePath}" onerror="this.style.display='none'">
        </div>

      </div>
    </div>
  `;
}


async function loadProductData(){
  // 🔹 Main UI composition for product data section
  try {
    const { group, cadComponents, cnc, print } = await loadAllSources();
    cachedSources = { group, cadComponents, cnc, print };
    syncSnapshotToFirestore(cachedSources);
    let html = "";

    html += `<div class="section-title">📦 Produktdaten</div>`;
    html += `<div class="data-grid product-grid">`;
    html += renderProductCard(cadComponents, group);
    html += `<div id="cadContainer">${renderCadCards(cadComponents)}</div>`;
    html += `</div>`;

    html += `<div class="section-title">🛠 Fertigungsdaten</div>`;
    html += `<div class="data-grid manufacturing-grid">`;
    html += renderCncCard(group, cnc);
    html += renderPrintCard(group, print);
    html += `</div>`;

    document.getElementById("productData").innerHTML = html;
    document.getElementById("productData").style.display = "block";
  } catch(e) {
    console.error("loadProductData ERROR:", e);
    document.getElementById("productData").innerHTML = "❌ Fehler beim Laden der Produktdaten";
    document.getElementById("productData").style.display = "block";
  }
}


// =========================================================
// 🔄 PROCESS / WORKFLOW LOGIC (FIRESTORE)
// =========================================================
function isStepUnlocked(stepId,data){
  const i = stepOrder.indexOf(stepId);
  if(i===0) return true;
  return data[stepOrder[i-1]]?.status==="bestanden";
}


async function initSteps(){
  const productRef = db.collection("products").doc(id);
  await productRef.set({created:true},{merge:true});

  // === PART B: Write minimal product snapshot fields on init (one-time)
  await productRef.set({
    _completed: 0,
    _total: stepOrder.length - 1,
    _endDone: false,
    _lastStepStatus: {}
  }, { merge: true });

  await Promise.all(stepOrder.map(async step => {
    const ref = productRef.collection("steps").doc(step);
    const snap = await ref.get();

    if(!snap.exists){
      const substeps={};
      (subStepsConfig[step]||[]).forEach(s=>substeps[s.id]=false);

      return ref.set({
        status:"nicht bestanden",
        substeps,
        last_update:"",
        last_user:""
      });
    }
  }));
}

function listenSteps(){
  db.collection("products").doc(id)
    .collection("steps")
    .onSnapshot(snap => processSnapshot(snap));
}

function processSnapshot(snap){

  const allStepsData={};
  snap.docs.forEach(d=>allStepsData[d.id]=d.data());

  let html="";

  if(role==="pruefung"){
    html += `<div class="mode-text">🔍 Prüfmodus aktiv</div>`;
  }

  const orderedDocs = stepOrder.map(stepName =>
    snap.docs.find(d => d.id === stepName)
  ).filter(Boolean);

  orderedDocs.forEach(docSnap=>{

    const step = docSnap.data();
    const stepId = docSnap.id;
    const unlocked = isStepUnlocked(stepId,allStepsData);
    const config = subStepsConfig[stepId] || [];

    const substeps = {};
    config.forEach(item=>{
      substeps[item.id] = step.substeps?.[item.id] ?? false;
    });

    const allDone = Object.values(substeps).every(v=>v);
    const total = Object.keys(substeps).length;
    const done = Object.values(substeps).filter(v=>v).length;
    const percent = Math.round((done / total) * 100);
    const status = getStatus(step, allDone, stepId, allStepsData);
    const isEndabnahme = stepId === "Endabnahme";
    const isLocked = isEndabnahme && role !== "pruefung";
    const lockIcon = isEndabnahme
      ? (isLocked ? "🔒" : "🔓")
      : "";
    let subHTML = `<div class="substeps-inline">`;

    config.forEach(item=>{
      const val = substeps[item.id];

      subHTML += `
        <div class="substep-item">
          <input type="checkbox"
            ${val?"checked":""}
            ${(!unlocked || role==="pruefung" || stepId==="Endabnahme")?"disabled":""}
            onchange="toggleSub('${stepId}')">
          <span>${item.label}</span>
        </div>
      `;
    });

    subHTML += `</div>`;

html += `
<div class="step-card">

  <div class="step-top">
    <h3>
      ${lockIcon ? `<span>${lockIcon}</span>` : ""}
      ${stepId}
    </h3>

    <div class="progress-container">
      <div class="progress-bar">
        <div class="progress-fill ${status}" style="width:${percent}%"></div>
      </div>
      <div class="progress-text">${percent}%</div>
    </div>

    ${getStatusBadge(status)}
  </div>

  <div class="step-meta">
    ${step.last_update||"-"} / ${step.last_user||"-"}
  </div>

  ${!unlocked ? "<div class='warning'>Schritt gesperrt</div>" : ""}

  ${subHTML}

  ${allDone ? `<div class="ready-text">✔ bereit zur Prüfung</div>` : ""}

  <div class="actions-row">
    <button onclick="toggleHistory('${stepId}')">📜 Verlauf</button>
  </div>

  <div id="hist_${stepId}" class="history">Lade...</div>

</div>
`;

  });

  contentDiv.innerHTML=html;
}

async function toggleSub(stepId){
  if(role==="pruefung") return;

  const ref = db.collection("products").doc(id)
    .collection("steps").doc(stepId);

  const config = subStepsConfig[stepId];
  const checkboxes = document.querySelectorAll(`input[onchange*="${stepId}"]`);

  const sub = {};
  let i=0;

  for(const cb of checkboxes){
    sub[config[i].id] = cb.checked;
    i++;
  }

  await ref.update({ substeps: sub });
}

async function saveStep(stepId){

  if(role!=="pruefung") return alert("Nur Prüfung darf Status setzen");

  const user=document.getElementById("user_"+stepId).value.trim();
  const status=document.getElementById("status_"+stepId).value;

  if(!user) return alert("Bitte Namen eingeben!");

  const time=new Date().toLocaleString();

  const ref=db.collection("products").doc(id)
    .collection("steps").doc(stepId);


  await ref.update({
    status,
    last_update:time,
    last_user:user
  });

  await ref.collection("history").add({
    user,
    timestamp:time,
    status,
    role,
    action:"Status geändert"
  });

  const btn = document.querySelector(`button[onclick="saveStep('${stepId}')"]`);

  if(btn){
    const original = btn.innerText;

    btn.innerText = "✔ Gespeichert";
    btn.disabled = true;

    setTimeout(()=>{
      btn.innerText = original;
      btn.disabled = false;
    }, 2000);
  }

  showToast("✔ Gespeichert");
}


async function syncSnapshotToFirestore(sources){
  try {
    const { group, cadComponents, cnc, print } = sources;
    const productRef = db.collection("products").doc(id);

    const cad = cadComponents?.[selectedCadIndex] || cadComponents?.[0];
    const comp = cad?.components?.[0];

    await productRef.set({

      // 🔹 Basisdaten
      product_name: group?.product_name || "-",
      group_name: group?.group_name || "-",

      // 🔹 CAD Snapshot
      cad: cad ? {
        component: comp?.name || "-",
        componentId: comp?.componentId || "-",
        material: (comp?.materials || []).join(", "),
        mass: comp?.mass_g || "-",
        volume: comp?.volume_cm3 || "-",
        bbox: comp?.boundingBox_mm
          ? `${comp.boundingBox_mm.length}×${comp.boundingBox_mm.width}×${comp.boundingBox_mm.height}`
          : "-",
        status: comp?.cadStatus || cad?.selectedComponent?.cadStatus || "-",
        hinweis: cad?.selectedComponent?.hinweis || comp?.hinweis || "-",
        exportedAt: cad?.exportedAt || null
      } : {},

      // 🔹 CNC Snapshot
      cnc: {
        component: group?.manufacturing?.cnc?.component || "-",
        machine: group?.manufacturing?.cnc?.machine || "-",
        material: group?.manufacturing?.cnc?.material || "-",
        tool: group?.manufacturing?.cnc?.tool || "-",

        source: cnc?.source || "-",
        control: cnc?.control || "-",
        speed: cnc?.cnc?.speed || "-",
        feed: cnc?.cnc?.feed || "-"
      },

      // 🔹 3D-Druck Snapshot
      print: {
        component: group?.manufacturing?.["3d_print"]?.component || "-",
        machine: group?.manufacturing?.["3d_print"]?.machine || "-",
        material: group?.manufacturing?.["3d_print"]?.material || "-",
        layer_height: group?.manufacturing?.["3d_print"]?.layer_height || "-",
        perimeter: group?.manufacturing?.["3d_print"]?.perimeter || "-",
        infill: group?.manufacturing?.["3d_print"]?.infill || "-",

        live_filament: print?.print?.filament || "-",
        live_layer_height: print?.print?.layer_height || "-",
        live_infill: print?.print?.infill || "-"
      }

    }, { merge: true });

  } catch(e){
    console.warn("Snapshot sync failed", e);
  }
}


// =========================================================
// 🌐 DATA SOURCE AGGREGATION
// =========================================================
async function loadAllSources(){

  const base = `data/${id}`;

  let group = null;
  let cad = null;
  let cnc = null;
  let print = null;

  try {
    const res = await fetch(`${base}/${id}.json`);
    group = await res.json();
  } catch {}

  let cadComponents = [];

  try {
    const indexRes = await fetch(`${base}/cad/cad_index.json`);

    if (!indexRes.ok) {
      throw new Error(`cad_index.json not found: ${indexRes.status}`);
    }

    const index = await indexRes.json();

    // 🔹 Load multiple CAD files safely
    // Promise.allSettled ensures that missing files (404) do NOT break the whole app
    // Only successfully loaded components are used
    const results = await Promise.allSettled(
      index.components.map(c => {
        const fileName = c.file.trim();
        const url = `${base}/cad/${fileName}`;
        // console.log("Loading CAD file:", url);

        return fetch(url)
          .then(r => {
            if (!r.ok) {
              // console.error("❌ CAD fetch failed:", url, r.status);
              throw new Error(`CAD file missing: ${fileName}`);
            }
            // console.log("✅ CAD loaded:", fileName);
            return r.json();
          })
          .then(data => ({
            ...data,
            _meta: c
          }));
      })
    );

    cadComponents = results
      .filter(r => r.status === "fulfilled")
      .map(r => r.value);

  } catch (e) {
    console.error("CAD load failed:", e);
  }

  try {
    const res = await fetch(`${base}/cnc/${FILES.cnc}`);
    cnc = await res.json();
  } catch {}

  try {
    const res = await fetch(`${base}/3dprint/${FILES.print}`);
    print = await res.json();
  } catch {}

  // === PART D: (Optional safety) reduce console noise in loadAllSources ===
  const DEBUG = false;
  if(DEBUG){
    console.log("LOADED:", { group, cadComponentsCount: cadComponents.length, cnc, print });
  }
  return { group, cadComponents, cnc, print };
}


async function toggleHistory(stepId){

  const div = document.getElementById("hist_"+stepId);

  if(div.style.display==="block"){
    div.style.display="none";
    return;
  }

  div.style.display="block";
  div.innerHTML="Lade...";

  const snap = await db.collection("products")
    .doc(id).collection("steps")
    .doc(stepId).collection("history")
    .orderBy("timestamp","desc").limit(10).get();

  let html="<table><tr><th>Zeit</th><th>User</th><th>Status</th><th>Aktion</th></tr>";

  snap.forEach(d=>{
    const h=d.data();
    html+=`<tr>
      <td>${h.timestamp}</td>
      <td>${h.user}</td>
      <td>${h.status||"-"}</td>
      <td>${h.action}</td>
    </tr>`;
  });

  html+="</table>";
  div.innerHTML=html;
}

// =========================================================
// 🚀 APPLICATION STARTUP
// =========================================================
// START
initSteps();
loadProductName();
loadProductData();

function startApp(){
  listenSteps();
}

// === PART C: Expose Firestore-only listener entry (for dashboard usage)
// Firestore-only product listener (for dashboard or header widgets)
function listenProductDoc(callback){
  return db.collection("products").doc(id)
    .onSnapshot(snap => {
      if(snap.exists){
        callback(snap.data());
      }
    });
}

contentDiv.style.display="none";
function changeCadComponent(index){
  selectedCadIndex = parseInt(index);

  if(!cachedSources) return;

  const { cadComponents } = cachedSources;
  const container = document.getElementById("cadContainer");

  if(container){
    container.innerHTML = renderCadCards(cadComponents);
  }
  syncSnapshotToFirestore(cachedSources);
}