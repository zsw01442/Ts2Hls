/**
 * Ts2Hls Dashboard Core Logic
 * Version: 1.3.1
 */

let channels = [];
let currentGroup = "";
let art = null;
let isExpertMode = false;

const PLAYLIST_PATH = "/playlist/ts2hls.m3u";
const DEFAULT_PLAYER_HINT = "Please select a channel";
const ALL_GROUP = "ALL";

const init = () => {
    if (window.lucide) {
        lucide.createIcons();
    }
    setupTabs();
    setupDragAndDrop();
    setupUrlImport();
    setupConfigActions();
    setupCopyButton();
    setupStopPreviewButton();
    loadListFromServer();
    loadConfigFromServer();
    checkStatus();
    setInterval(checkStatus, 3000);
};

const setupTabs = () => {
    const btnC = document.getElementById("tabConsole");
    const btnP = document.getElementById("tabPreview");
    const pageC = document.getElementById("consolePage");
    const pageP = document.getElementById("previewPage");
    if (!btnC || !btnP || !pageC || !pageP) return;

    const switchTab = (toConsole) => {
        btnC.className = toConsole ? "tab-btn active" : "tab-btn inactive";
        btnP.className = !toConsole ? "tab-btn active" : "tab-btn inactive";
        pageC.classList.toggle("hidden", !toConsole);
        pageP.classList.toggle("hidden", toConsole);

        if (!toConsole) {
            setTimeout(() => {
                if (art) art.resize();
            }, 150);
            renderPreview();
        }
    };

    btnC.onclick = () => switchTab(true);
    btnP.onclick = () => switchTab(false);
};

const renderPreview = () => {
    const gc = document.getElementById("groupContainer");
    const grid = document.getElementById("channelGrid");
    if (!gc || !grid) return;

    const groups = [...new Set(channels.map((c) => c.group).filter(Boolean))];
    if (!currentGroup || (currentGroup !== ALL_GROUP && !groups.includes(currentGroup))) {
        currentGroup = groups[0] || ALL_GROUP;
    }

    const displayGroups = [...groups, ALL_GROUP];
    gc.innerHTML = "";
    displayGroups.forEach((g) => {
        const btn = document.createElement("button");
        btn.className = `group-tag ${currentGroup === g ? "active" : ""}`;
        btn.textContent = g;
        btn.onclick = () => {
            currentGroup = g;
            renderPreview();
        };
        gc.appendChild(btn);
    });

    grid.innerHTML = "";
    const filtered = currentGroup === ALL_GROUP ? channels : channels.filter((c) => c.group === currentGroup);
    filtered.forEach((ch) => {
        const b = document.createElement("div");
        b.className = "channel-btn";
        b.innerHTML = `
            <img src="${ch.logo || "/static/logo.png"}" onerror="this.src='/static/logo.png'" alt="">
            <span>${ch.name || "Unnamed Channel"}</span>
        `;
        b.onclick = () => playStream(ch);
        grid.appendChild(b);
    });
};

const resetPlayerContainer = (text = DEFAULT_PLAYER_HINT) => {
    const container = document.getElementById("playerContainer");
    if (!container) return;
    container.innerHTML = `<div class="w-full h-full flex items-center justify-center text-slate-400 font-bold">${text}</div>`;
};

const stopPreview = (showPlaceholder = true) => {
    if (art) {
        try {
            if (art.__hls && typeof art.__hls.destroy === "function") {
                art.__hls.destroy();
            }
        } catch (_) {}

        try {
            const video = art.video;
            if (video) {
                video.pause();
                video.removeAttribute("src");
                video.load();
            }
        } catch (_) {}

        try {
            art.destroy(true);
        } catch (_) {}
        art = null;
    }

    if (showPlaceholder) {
        resetPlayerContainer();
    }
};

const playStream = (ch) => {
    const container = document.getElementById("playerContainer");
    if (!container) return;

    stopPreview(false);
    container.innerHTML = "";

    art = new Artplayer({
        container,
        url: `/stream/${ch.id}/index.m3u8`,
        isLive: true,
        autoplay: true,
        theme: "#4f46e5",
        fullscreen: true,
        playbackRate: true,
        aspectRatio: true,
        setting: true,
        customType: {
            m3u8: function(video, url, artInstance) {
                if (window.Hls && Hls.isSupported()) {
                    const hls = new Hls();
                    artInstance.__hls = hls;
                    hls.loadSource(url);
                    hls.attachMedia(video);
                } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
                    video.src = url;
                }
            },
        },
    });
};

async function loadListFromServer() {
    try {
        const res = await fetch("/api/list?t=" + Date.now());
        const data = await res.json();
        channels = Array.isArray(data) ? data : (data.channels || []);

        const channelCount = document.getElementById("channelCount");
        if (channelCount) channelCount.textContent = channels.length;

        const m3uUrl = document.getElementById("m3uUrl");
        if (m3uUrl) m3uUrl.value = `${window.location.origin}${PLAYLIST_PATH}`;

        renderPreview();
    } catch (_) {}
}

async function checkStatus() {
    try {
        const r = await fetch("/api/status?t=" + Date.now());
        const d = await r.json();
        const processCount = document.getElementById("processCount");
        const cpuUsage = document.getElementById("cpuUsage");
        const memUsage = document.getElementById("memUsage");
        if (processCount) processCount.textContent = d.active_count || 0;
        if (cpuUsage) cpuUsage.textContent = d.cpu || "0";
        if (memUsage) memUsage.textContent = d.mem || "0";
    } catch (_) {}
}

async function loadConfigFromServer() {
    try {
        const res = await fetch("/api/config");
        const config = await res.json();
        const form = document.getElementById("configForm");
        if (!form) return;

        Object.keys(config).forEach((key) => {
            const el = form.querySelector(`[name="${key}"]`);
            if (!el) return;
            const val = String(config[key]);
            if (el.tagName === "SELECT" && !Array.from(el.options).some((o) => o.value === val)) {
                el.add(new Option(val, val));
            }
            el.value = val;
        });
    } catch (_) {}
}

function setupConfigActions() {
    const expertModeBtn = document.getElementById("expertModeBtn");
    const saveConfigBtn = document.getElementById("saveConfigBtn");
    const resetConfigBtn = document.getElementById("resetConfigBtn");
    const configActions = document.getElementById("configActions");
    const configForm = document.getElementById("configForm");
    if (!expertModeBtn || !saveConfigBtn || !resetConfigBtn || !configActions || !configForm) return;

    expertModeBtn.onclick = () => {
        isExpertMode = !isExpertMode;
        const inputs = document.querySelectorAll("#configForm select");
        inputs.forEach((i) => {
            i.disabled = !isExpertMode;
        });

        configActions.classList.toggle("hidden", !isExpertMode);
        expertModeBtn.textContent = isExpertMode ? "Cancel Edit" : "Edit Config";
    };

    saveConfigBtn.onclick = async () => {
        const fd = new FormData(configForm);
        const data = Object.fromEntries(fd.entries());
        const numKeys = ["max_processes", "hls_time", "hls_list_size", "idle_timeout", "reconnect_delay"];
        numKeys.forEach((k) => {
            if (data[k] !== undefined) data[k] = parseInt(data[k], 10);
        });

        try {
            const res = await fetch("/api/config", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(data),
            });
            if (!res.ok) {
                throw new Error("save failed");
            }
            alert("Config updated");
            location.reload();
        } catch (_) {
            alert("Save failed");
        }
    };

    resetConfigBtn.onclick = async () => {
        if (!confirm("Reset config to defaults?")) return;
        await fetch("/api/config?action=reset", { method: "POST" });
        location.reload();
    };
}

function setupDragAndDrop() {
    const zone = document.getElementById("dropZone");
    const input = document.getElementById("fileInput");
    const uploadBtn = document.getElementById("uploadBtn");
    if (!zone || !input || !uploadBtn) return;

    ["dragenter", "dragover", "dragleave", "drop"].forEach((eventName) => {
        zone.addEventListener(eventName, (e) => {
            e.preventDefault();
            e.stopPropagation();
        }, false);
    });

    zone.onclick = () => input.click();
    zone.addEventListener("dragover", () => zone.classList.add("bg-indigo-50"), false);
    zone.addEventListener("dragleave", () => zone.classList.remove("bg-indigo-50"), false);

    zone.addEventListener("drop", (e) => {
        zone.classList.remove("bg-indigo-50");
        const files = e.dataTransfer?.files;
        if (files && files.length > 0) {
            input.files = files;
            handleFileSelect(files[0]);
        }
    }, false);

    input.onchange = () => {
        if (input.files && input.files[0]) {
            handleFileSelect(input.files[0]);
        }
    };

    function handleFileSelect(file) {
        const content = document.getElementById("dropZoneContent");
        if (!content) return;
        content.innerHTML = `
            <i data-lucide="check-circle" class="w-10 h-10 text-emerald-500 mx-auto mb-4"></i>
            <p class="text-xs font-bold text-indigo-600">Selected: ${file.name}</p>
        `;
        if (window.lucide) lucide.createIcons();
    }

    uploadBtn.onclick = async () => {
        if (!input.files || !input.files[0]) {
            alert("Please select an M3U file first");
            return;
        }

        uploadBtn.disabled = true;
        uploadBtn.textContent = "Processing...";

        const fd = new FormData();
        fd.append("m3uFile", input.files[0]);

        try {
            const res = await fetch("/api/upload", { method: "POST", body: fd });
            if (!res.ok) {
                const msg = await res.text();
                throw new Error(msg || "upload failed");
            }

            const data = await res.json();
            alert(`Import success, parsed ${data.count || 0} channels`);
            await loadListFromServer();
            input.value = "";
        } catch (e) {
            alert(`Upload failed: ${e.message || "request error"}`);
        } finally {
            uploadBtn.disabled = false;
            uploadBtn.textContent = "Upload and Convert";
        }
    };
}

function setupUrlImport() {
    const urlInput = document.getElementById("m3uUrlInput");
    const uploadUrlBtn = document.getElementById("uploadUrlBtn");
    if (!urlInput || !uploadUrlBtn) return;

    const submit = async () => {
        const value = (urlInput.value || "").trim();
        if (!/^https?:\/\//i.test(value)) {
            alert("Please input a valid http/https M3U URL");
            return;
        }

        uploadUrlBtn.disabled = true;
        const oldText = uploadUrlBtn.textContent;
        uploadUrlBtn.textContent = "Importing...";

        try {
            const res = await fetch("/api/upload/url", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ url: value }),
            });
            if (!res.ok) {
                const msg = await res.text();
                throw new Error(msg || "import failed");
            }

            const data = await res.json();
            alert(`Import success, parsed ${data.count || 0} channels`);
            urlInput.value = "";
            await loadListFromServer();
        } catch (e) {
            alert(`URL import failed: ${e.message || "request error"}`);
        } finally {
            uploadUrlBtn.disabled = false;
            uploadUrlBtn.textContent = oldText;
        }
    };

    uploadUrlBtn.onclick = submit;
    urlInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            submit();
        }
    });
}

function setupCopyButton() {
    const copyBtn = document.getElementById("copyBtn");
    const m3uUrl = document.getElementById("m3uUrl");
    if (!copyBtn || !m3uUrl) return;

    const copyToClipboard = (text) => {
        if (navigator.clipboard && window.isSecureContext) {
            return navigator.clipboard.writeText(text);
        }

        return new Promise((resolve, reject) => {
            const textArea = document.createElement("textarea");
            textArea.value = text;
            textArea.style.position = "fixed";
            textArea.style.left = "-9999px";
            textArea.style.top = "0";
            document.body.appendChild(textArea);
            textArea.focus();
            textArea.select();
            try {
                const ok = document.execCommand("copy");
                document.body.removeChild(textArea);
                ok ? resolve() : reject(new Error("copy failed"));
            } catch (err) {
                document.body.removeChild(textArea);
                reject(err);
            }
        });
    };

    copyBtn.onclick = () => {
        const url = m3uUrl.value || "";
        copyToClipboard(url).then(() => {
            const oldText = copyBtn.textContent;
            copyBtn.textContent = "Copied";
            copyBtn.classList.replace("bg-slate-900", "bg-emerald-600");
            setTimeout(() => {
                copyBtn.textContent = oldText;
                copyBtn.classList.replace("bg-emerald-600", "bg-slate-900");
            }, 2000);
        }).catch(() => {});
    };
}

function setupStopPreviewButton() {
    const btn = document.getElementById("stopPreviewBtn");
    if (!btn) return;
    btn.onclick = () => stopPreview(true);
}

window.onload = init;
