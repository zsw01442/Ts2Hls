/**
 * Ts2Hls Dashboard Core Logic
 * Version: 1.4.0
 */

let channels = [];
let currentGroup = "";
let art = null;
let isExpertMode = false;
let sources = [];
let currentSourceKey = "";

const DEFAULT_PLAYER_HINT = "请选择频道";
const ALL_GROUP = "全部";
const SOURCE_CACHE_KEY = "ts2hls.active_source";

const init = async () => {
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
    setupSourceRenameButton();

    await loadSources();
    renderSourceTabs();
    await loadCurrentSourceData();

    setInterval(checkStatus, 3000);
};

const withSourceQuery = (url) => {
    const key = currentSourceKey || "source1";
    const joiner = url.includes("?") ? "&" : "?";
    return `${url}${joiner}source=${encodeURIComponent(key)}`;
};

const getCurrentSource = () => {
    return sources.find((s) => s.key === currentSourceKey) || sources[0] || null;
};

const playlistPathForSource = (source) => {
    if (!source || !source.slug) return "";
    return `/playlist/${source.slug}.m3u`;
};

const updatePlaylistUrl = () => {
    const m3uUrl = document.getElementById("m3uUrl");
    if (!m3uUrl) return;
    const src = getCurrentSource();
    const path = playlistPathForSource(src);
    m3uUrl.value = path ? `${window.location.origin}${path}` : "";
};

const renderSourceTabs = () => {
    const container = document.getElementById("sourceSwitcher");
    if (!container) return;

    container.innerHTML = "";
    sources.forEach((source) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = `source-btn ${currentSourceKey === source.key ? "active" : ""}`;
        btn.textContent = source.name || source.key;
        btn.onclick = () => switchSource(source.key);
        container.appendChild(btn);
    });
};

const switchSource = async (sourceKey) => {
    if (!sourceKey || sourceKey === currentSourceKey) return;

    currentSourceKey = sourceKey;
    localStorage.setItem(SOURCE_CACHE_KEY, sourceKey);
    currentGroup = "";
    channels = [];

    stopPreview(true);
    resetDropZoneContent();

    const fileInput = document.getElementById("fileInput");
    if (fileInput) fileInput.value = "";
    const urlInput = document.getElementById("m3uUrlInput");
    if (urlInput) urlInput.value = "";

    renderSourceTabs();
    await loadCurrentSourceData();
};

const loadSources = async () => {
    try {
        const res = await fetch("/api/sources?t=" + Date.now());
        if (!res.ok) throw new Error("加载直播源失败");
        const data = await res.json();
        const list = Array.isArray(data) ? data : data.sources;
        sources = Array.isArray(list) ? list : [];
    } catch (_) {
        sources = [
            { key: "source1", name: "直播源一", slug: "source1" },
            { key: "source2", name: "直播源二", slug: "source2" },
            { key: "source3", name: "直播源三", slug: "source3" },
        ];
    }

    const cached = localStorage.getItem(SOURCE_CACHE_KEY);
    const hasCached = cached && sources.some((s) => s.key === cached);
    if (hasCached) {
        currentSourceKey = cached;
    } else if (!currentSourceKey || !sources.some((s) => s.key === currentSourceKey)) {
        currentSourceKey = (sources[0] && sources[0].key) || "source1";
        localStorage.setItem(SOURCE_CACHE_KEY, currentSourceKey);
    }
};

const loadCurrentSourceData = async () => {
    renderPreview();
    updatePlaylistUrl();
    await loadListFromServer();
    await loadConfigFromServer();
    await checkStatus();
};

function setupSourceRenameButton() {
    const renameBtn = document.getElementById("renameSourceBtn");
    if (!renameBtn) return;

    renameBtn.onclick = async () => {
        const current = getCurrentSource();
        if (!current) return;

        const name = prompt("请输入新的直播源名称", current.name || "");
        if (name === null) return;

        const clean = (name || "").trim();
        if (!clean) {
            alert("名称不能为空");
            return;
        }

        renameBtn.disabled = true;
        const oldText = renameBtn.textContent;
        renameBtn.textContent = "正在保存...";

        try {
            const res = await fetch("/api/sources/rename", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ key: currentSourceKey, name: clean }),
            });
            if (!res.ok) {
                const msg = await res.text();
                throw new Error(msg || "重命名失败");
            }

            await loadSources();
            renderSourceTabs();
            updatePlaylistUrl();
            alert("直播源名称已更新");
        } catch (e) {
            alert(`重命名失败：${e.message || "请求出错"}`);
        } finally {
            renameBtn.disabled = false;
            renameBtn.textContent = oldText;
        }
    };
}

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
    const displayGroups = groups.length > 0 ? [...groups, ALL_GROUP] : [ALL_GROUP];

    if (!currentGroup || !displayGroups.includes(currentGroup)) {
        currentGroup = displayGroups[0];
    }

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
            <span>${ch.name || "未命名频道"}</span>
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
        <p class="text-xs font-bold text-slate-400">点击或拖拽 M3U 文件</p>
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
    if (!container || !currentSourceKey) return;

    stopPreview(false);
    container.innerHTML = "";

    const sourceKey = encodeURIComponent(currentSourceKey);
    art = new Artplayer({
        container,
        url: `/stream/${sourceKey}/${ch.id}/index.m3u8`,
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
        const res = await fetch(withSourceQuery("/api/list?t=" + Date.now()));
        const data = await res.json();
        channels = Array.isArray(data) ? data : (data.channels || []);

        const channelCount = document.getElementById("channelCount");
        if (channelCount) channelCount.textContent = channels.length;

        updatePlaylistUrl();
        renderPreview();
    } catch (_) {
        channels = [];
        const channelCount = document.getElementById("channelCount");
        if (channelCount) channelCount.textContent = "0";
        renderPreview();
    }
}

async function checkStatus() {
    try {
        const r = await fetch(withSourceQuery("/api/status?t=" + Date.now()));
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
        const res = await fetch(withSourceQuery("/api/config"));
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

function exitExpertMode() {
    isExpertMode = false;
    const expertModeBtn = document.getElementById("expertModeBtn");
    const configActions = document.getElementById("configActions");
    const inputs = document.querySelectorAll("#configForm select");
    inputs.forEach((i) => {
        i.disabled = true;
    });
    if (configActions) {
        configActions.classList.add("hidden");
    }
    if (expertModeBtn) {
        expertModeBtn.textContent = "编辑配置";
    }
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
        expertModeBtn.textContent = isExpertMode ? "取消修改" : "编辑配置";
    };

    saveConfigBtn.onclick = async () => {
        const fd = new FormData(configForm);
        const data = Object.fromEntries(fd.entries());
        const numKeys = ["max_processes", "hls_time", "hls_list_size", "idle_timeout", "reconnect_delay"];
        numKeys.forEach((k) => {
            if (data[k] !== undefined) data[k] = parseInt(data[k], 10);
        });

        try {
            const res = await fetch(withSourceQuery("/api/config"), {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(data),
            });
            if (!res.ok) {
                throw new Error("保存失败");
            }

            await loadConfigFromServer();
            exitExpertMode();
            alert("配置已更新");
        } catch (_) {
            alert("保存失败");
        }
    };

    resetConfigBtn.onclick = async () => {
        if (!confirm("确定要恢复默认配置吗？")) return;
        try {
            const res = await fetch(withSourceQuery("/api/config?action=reset"), { method: "POST" });
            if (!res.ok) throw new Error();
            await loadConfigFromServer();
            exitExpertMode();
            alert("配置已重置");
        } catch (_) {
            alert("重置失败");
        }
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
            <p class="text-xs font-bold text-indigo-600">已选择: ${file.name}</p>
        `;
        if (window.lucide) lucide.createIcons();
    }

    uploadBtn.onclick = async () => {
        if (!input.files || !input.files[0]) {
            alert("请先选择 M3U 文件");
            return;
        }

        uploadBtn.disabled = true;
        uploadBtn.textContent = "正在处理...";

        const fd = new FormData();
        fd.append("m3uFile", input.files[0]);

        try {
            const res = await fetch(withSourceQuery("/api/upload"), { method: "POST", body: fd });
            if (!res.ok) {
                const msg = await res.text();
                throw new Error(msg || "上传失败");
            }

            const data = await res.json();
            alert(`导入成功，已解析 ${data.count || 0} 路频道`);
            await loadListFromServer();
            await checkStatus();
            input.value = "";
        } catch (e) {
            alert(`上传失败：${e.message || "请求出错"}`);
        } finally {
            uploadBtn.disabled = false;
            uploadBtn.textContent = "上传并转换";
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
            alert("请输入有效的 http/https M3U 订阅链接");
            return;
        }

        uploadUrlBtn.disabled = true;
        const oldText = uploadUrlBtn.textContent;
        uploadUrlBtn.textContent = "正在处理...";

        try {
            const res = await fetch(withSourceQuery("/api/upload/url"), {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ url: value }),
            });
            if (!res.ok) {
                const msg = await res.text();
                throw new Error(msg || "导入失败");
            }

            const data = await res.json();
            alert(`导入成功，已解析 ${data.count || 0} 路频道`);
            urlInput.value = "";
            await loadListFromServer();
            await checkStatus();
        } catch (e) {
            alert(`链接导入失败：${e.message || "请求出错"}`);
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

    clearBtn.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!confirm("确定清除当前直播源已导入的数据吗？")) return;

        clearBtn.disabled = true;
        const oldText = clearBtn.textContent;
        clearBtn.textContent = "正在清除...";

        try {
            const res = await fetch(withSourceQuery("/api/data/clear"), { method: "POST" });
            if (!res.ok) {
                const msg = await res.text();
                throw new Error(msg || "清除失败");
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
            await checkStatus();
            alert("已清除当前直播源导入数据");
        } catch (e) {
            alert(`清除失败：${e.message || "请求出错"}`);
        } finally {
            clearBtn.disabled = false;
            clearBtn.textContent = oldText;
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
            copyBtn.textContent = "已复制";
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

window.onload = () => {
    init().catch(() => {});
};
