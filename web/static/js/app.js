/**
 * Ts2Hls Dashboard Core Logic
 * Version: 1.3.3
 */

let channels = [];
let currentGroup = "";
let art = null;
let isExpertMode = false;

const PLAYLIST_PATH = "/playlist/ts2hls.m3u";
const DEFAULT_PLAYER_HINT = "\u8bf7\u9009\u62e9\u9891\u9053";
const ALL_GROUP = "\u5168\u90e8";

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
    setupClearDataButton();
    loadListFromServer();
    loadConfigFromServer();
    checkStatus();
    setInterval(checkStatus, 3000);
};

const setupTabs = () => {
    const btnConsole = document.getElementById("tabConsole");
    const btnPreview = document.getElementById("tabPreview");
    const pageConsole = document.getElementById("consolePage");
    const pagePreview = document.getElementById("previewPage");
    if (!btnConsole || !btnPreview || !pageConsole || !pagePreview) return;

    const switchTab = (toConsole) => {
        btnConsole.className = toConsole ? "tab-btn active" : "tab-btn inactive";
        btnPreview.className = !toConsole ? "tab-btn active" : "tab-btn inactive";
        pageConsole.classList.toggle("hidden", !toConsole);
        pagePreview.classList.toggle("hidden", toConsole);

        if (!toConsole) {
            setTimeout(() => {
                if (art) art.resize();
            }, 150);
            renderPreview();
        }
    };

    btnConsole.onclick = () => switchTab(true);
    btnPreview.onclick = () => switchTab(false);
};

const renderPreview = () => {
    const groupContainer = document.getElementById("groupContainer");
    const channelGrid = document.getElementById("channelGrid");
    if (!groupContainer || !channelGrid) return;

    const groups = [...new Set(channels.map((c) => c.group).filter(Boolean))];
    if (!currentGroup || (currentGroup !== ALL_GROUP && !groups.includes(currentGroup))) {
        currentGroup = groups[0] || ALL_GROUP;
    }

    const displayGroups = [...groups, ALL_GROUP];
    groupContainer.innerHTML = "";
    displayGroups.forEach((g) => {
        const btn = document.createElement("button");
        btn.className = `group-tag ${currentGroup === g ? "active" : ""}`;
        btn.textContent = g;
        btn.onclick = () => {
            currentGroup = g;
            renderPreview();
        };
        groupContainer.appendChild(btn);
    });

    channelGrid.innerHTML = "";
    const filtered = currentGroup === ALL_GROUP ? channels : channels.filter((c) => c.group === currentGroup);
    filtered.forEach((ch) => {
        const b = document.createElement("div");
        b.className = "channel-btn";
        b.innerHTML = `
            <img src="${ch.logo || "/static/logo.png"}" onerror="this.src='/static/logo.png'" alt="">
            <span>${ch.name || "\u672a\u547d\u540d\u9891\u9053"}</span>
        `;
        b.onclick = () => playStream(ch);
        channelGrid.appendChild(b);
    });
};

const resetPlayerContainer = (text = DEFAULT_PLAYER_HINT) => {
    const container = document.getElementById("playerContainer");
    if (!container) return;
    container.innerHTML = `<div class="w-full h-full flex items-center justify-center text-slate-400 font-bold">${text}</div>`;
};

const resetDropZoneContent = () => {
    const content = document.getElementById("dropZoneContent");
    if (!content) return;
    content.innerHTML = `
        <i data-lucide="file-plus" class="w-10 h-10 text-slate-300 mx-auto mb-4"></i>
        <p class="text-xs font-bold text-slate-400">\u70b9\u51fb\u6216\u62d6\u62fd M3U \u6587\u4ef6</p>
    `;
    if (window.lucide) lucide.createIcons();
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
        expertModeBtn.textContent = isExpertMode ? "\u53d6\u6d88\u4fee\u6539" : "\u7f16\u8f91\u914d\u7f6e";
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
                throw new Error("\u4fdd\u5b58\u5931\u8d25");
            }
            alert("\u914d\u7f6e\u5df2\u66f4\u65b0");
            location.reload();
        } catch (_) {
            alert("\u4fdd\u5b58\u5931\u8d25");
        }
    };

    resetConfigBtn.onclick = async () => {
        if (!confirm("\u786e\u5b9a\u8981\u6062\u590d\u9ed8\u8ba4\u914d\u7f6e\u5417\uff1f")) return;
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
            <p class="text-xs font-bold text-indigo-600">\u5df2\u9009\u62e9: ${file.name}</p>
        `;
        if (window.lucide) lucide.createIcons();
    }

    uploadBtn.onclick = async () => {
        if (!input.files || !input.files[0]) {
            alert("\u8bf7\u5148\u9009\u62e9 M3U \u6587\u4ef6");
            return;
        }

        uploadBtn.disabled = true;
        uploadBtn.textContent = "\u6b63\u5728\u5904\u7406...";

        const fd = new FormData();
        fd.append("m3uFile", input.files[0]);

        try {
            const res = await fetch("/api/upload", { method: "POST", body: fd });
            if (!res.ok) {
                const msg = await res.text();
                throw new Error(msg || "\u4e0a\u4f20\u5931\u8d25");
            }

            const data = await res.json();
            alert(`\u5bfc\u5165\u6210\u529f\uff0c\u5df2\u89e3\u6790 ${data.count || 0} \u8def\u9891\u9053`);
            await loadListFromServer();
            input.value = "";
        } catch (e) {
            alert(`\u4e0a\u4f20\u5931\u8d25\uff1a${e.message || "\u8bf7\u6c42\u51fa\u9519"}`);
        } finally {
            uploadBtn.disabled = false;
            uploadBtn.textContent = "\u4e0a\u4f20\u5e76\u8f6c\u6362";
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
            alert("\u8bf7\u8f93\u5165\u6709\u6548\u7684 http/https M3U \u8ba2\u9605\u94fe\u63a5");
            return;
        }

        uploadUrlBtn.disabled = true;
        const oldText = uploadUrlBtn.textContent;
        uploadUrlBtn.textContent = "\u6b63\u5728\u5904\u7406...";

        try {
            const res = await fetch("/api/upload/url", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ url: value }),
            });
            if (!res.ok) {
                const msg = await res.text();
                throw new Error(msg || "\u5bfc\u5165\u5931\u8d25");
            }

            const data = await res.json();
            alert(`\u5bfc\u5165\u6210\u529f\uff0c\u5df2\u89e3\u6790 ${data.count || 0} \u8def\u9891\u9053`);
            urlInput.value = "";
            await loadListFromServer();
        } catch (e) {
            alert(`\u94fe\u63a5\u5bfc\u5165\u5931\u8d25\uff1a${e.message || "\u8bf7\u6c42\u51fa\u9519"}`);
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

function setupClearDataButton() {
    const clearBtn = document.getElementById("clearDataBtn");
    if (!clearBtn) return;

    clearBtn.onclick = async () => {
        if (!confirm("\u786e\u5b9a\u6e05\u9664\u5df2\u5bfc\u5165\u7684\u6570\u636e\u5417\uff1f")) return;

        clearBtn.disabled = true;
        const oldText = clearBtn.textContent;
        clearBtn.textContent = "\u6b63\u5728\u6e05\u9664...";

        try {
            const res = await fetch("/api/data/clear", { method: "POST" });
            if (!res.ok) {
                const msg = await res.text();
                throw new Error(msg || "\u6e05\u9664\u5931\u8d25");
            }

            stopPreview(true);
            channels = [];
            currentGroup = ALL_GROUP;
            renderPreview();

            const channelCount = document.getElementById("channelCount");
            if (channelCount) channelCount.textContent = "0";
            resetDropZoneContent();

            const fileInput = document.getElementById("fileInput");
            if (fileInput) fileInput.value = "";

            const urlInput = document.getElementById("m3uUrlInput");
            if (urlInput) urlInput.value = "";

            await loadListFromServer();
            alert("\u5df2\u6e05\u9664\u5df2\u5bfc\u5165\u6570\u636e");
        } catch (e) {
            alert(`\u6e05\u9664\u5931\u8d25\uff1a${e.message || "\u8bf7\u6c42\u51fa\u9519"}`);
        } finally {
            clearBtn.disabled = false;
            clearBtn.textContent = oldText;
        }
    };
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
            copyBtn.textContent = "\u5df2\u590d\u5236";
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
