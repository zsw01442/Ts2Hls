let channels = [];
let currentGroup = ''; 
let artPlayer = null;
let isExpertMode = false;

function init() {
    lucide.createIcons();
    setupDragAndDrop();
    loadListFromServer();
    loadConfigFromServer(); 
}

// --- 配置管理逻辑 ---

async function loadConfigFromServer() {
    try {
        const res = await fetch('/api/config');
        if (res.ok) {
            const config = await res.json();
            const form = document.getElementById('configForm');
            
            Object.keys(config).forEach(key => {
                const input = form.querySelector(`[name="${key}"]`);
                if (input) {
                    // 核心修正：强制转为字符串并去掉两端空格
                    // 这样 JSON 中的 6 就能匹配到 <option value="6">
                    const val = String(config[key]).trim();
                    
                    // 检查该值是否存在于下拉选项中
                    const optionExists = Array.from(input.options).some(opt => opt.value === val);
                    
                    if (optionExists) {
                        input.value = val;
                    } else {
                        // 如果后端的值(如 120)不在预设选项(60, 300)里
                        // 动态创建一个临时选项，避免显示空白
                        const newOpt = new Option(val, val);
                        input.add(newOpt);
                        input.value = val;
                        console.warn(`字段 ${key} 的值 ${val} 不在预设选项中，已创建临时项`);
                    }
                }
            });
        }
    } catch (e) { 
        console.error("配置加载失败", e); 
    }
}

function toggleExpertMode() {
    isExpertMode = !isExpertMode;
    const btn = document.getElementById('expertModeBtn');
    const actions = document.getElementById('configActions');
    const configCard = document.querySelector('.config-card');
    // 同时也选中所有的 select，因为你 HTML 里全是 select
    const inputs = document.querySelectorAll('#configForm select, #configForm input');

    if (isExpertMode) {
        btn.textContent = "退出编辑";
        btn.classList.add('bg-slate-200', 'text-slate-600');
        btn.classList.remove('bg-indigo-50', 'text-indigo-600');
        actions.classList.remove('hidden');
        inputs.forEach(i => i.disabled = false);
        configCard.classList.add('is-expert-active'); 
    } else {
        btn.textContent = "编辑配置";
        btn.classList.remove('bg-slate-200', 'text-slate-600');
        btn.classList.add('bg-indigo-50', 'text-indigo-600');
        actions.classList.add('hidden');
        inputs.forEach(i => i.disabled = true);
        configCard.classList.remove('is-expert-active');
        loadConfigFromServer(); // 放弃修改，重新加载
    }
}

// 绑定编辑按钮
const expertBtn = document.getElementById('expertModeBtn');
if(expertBtn) expertBtn.onclick = toggleExpertMode;

    document.getElementById('saveConfigBtn').onclick = async () => {
        const form = document.getElementById('configForm');
        const inputs = form.querySelectorAll('select, input');
        const data = {};
        
        // 防御性编程：确保每个字段都正确处理
        inputs.forEach(el => {
            const key = el.name;
            if (!key) return; // 跳过没有 name 属性的元素
            
            const value = el.value;
            const numericFields = ['max_processes', 'hls_time', 'hls_list_size', 'idle_timeout', 'reconnect_delay'];

            if (numericFields.includes(key)) {
                const num = parseInt(value);
                // 防御：如果转换失败，给个默认值或跳过，避免传 NaN 导致 400
                data[key] = isNaN(num) ? 0 : num; 
            } else {
                data[key] = value;
            }
        });

        console.log("?? 发送给后端的数据:", data); // 调试用：看看数据对不对

        try {
            const res = await fetch('/api/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });

            if (res.ok) {
                alert("✅ 配置保存成功");
                location.reload(); 
            } else {
                const errText = await res.text();
                alert("❌ 保存失败: " + errText);
            }
        } catch (e) { 
            alert("❌ 网络错误，请检查后端服务"); 
        }
    };

document.getElementById('resetConfigBtn').onclick = async () => {
    if(!confirm("确定重置所有参数吗？")) return;
    try {
        const res = await fetch('/api/config?action=reset', { method: 'POST' });
        if (res.ok) {
            await loadConfigFromServer();
            alert("已恢复默认值");
            // 注意：重置后不需要 toggleExpertMode()，让用户继续决定是否退出
        }
    } catch (e) { alert("重置失败"); }
};

// --- 原有上传与预览逻辑 (无需改动) ---

async function loadListFromServer() {
    try {
        const res = await fetch('/api/list?cache_bust=' + Date.now());
        if (!res.ok) throw new Error("服务器响应异常");
        const rawData = await res.json();
        let list = Array.isArray(rawData) ? rawData : (rawData.channels || []);
        if (list.length > 0) {
            channels = list;
            updateUI(channels.length);
            return true;
        }
    } catch (e) { console.error("同步失败:", e); }
    return false;
}

function setupDragAndDrop() {
    const fileInput = document.getElementById('fileInput');
    const dropZone = document.getElementById('dropZone');
    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.classList.add('border-indigo-500', 'bg-indigo-50');
    });
    ['dragleave', 'drop'].forEach(n => {
        dropZone.addEventListener(n, () => dropZone.classList.remove('border-indigo-500', 'bg-indigo-50'));
    });
    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        if (e.dataTransfer.files.length > 0) {
            fileInput.files = e.dataTransfer.files;
            handleFileSelect(e.dataTransfer.files[0].name);
        }
    });
    dropZone.onclick = () => fileInput.click();
    fileInput.onchange = () => { if(fileInput.files[0]) handleFileSelect(fileInput.files[0].name); };
}

function handleFileSelect(name) {
    document.getElementById('dropZoneContent').innerHTML = `
        <i data-lucide="check-circle" class="w-12 h-12 text-emerald-500 mx-auto mb-4"></i>
        <p class="text-indigo-600 font-bold">已选: ${name}</p>
    `;
    lucide.createIcons();
}

document.getElementById('uploadBtn').onclick = async () => {
    const fileInput = document.getElementById('fileInput');
    if(!fileInput.files[0]) return fileInput.click();
    const btn = document.getElementById('uploadBtn');
    btn.textContent = "正在转换..."; btn.disabled = true;
    const fd = new FormData(); fd.append('m3uFile', fileInput.files[0]);
    try {
        const res = await fetch('/api/upload', { method: 'POST', body: fd });
        if (res.ok) {
            await new Promise(r => setTimeout(r, 2000));
            await loadListFromServer();
        }
    } finally {
        btn.textContent = "开始转换"; btn.disabled = false;
    }
};

function updateUI(count) {
    const urlInput = document.getElementById('m3uUrl');
    urlInput.value = `${window.location.origin}/playlist/tstohls.m3u`;
    urlInput.classList.replace('text-slate-400', 'text-indigo-600');
    document.getElementById('channelCount').textContent = count;
    
    const statusText = document.getElementById('previewStatusText');
    if (count > 0 && statusText) {
        statusText.innerHTML = `<i data-lucide="layout-list" class="w-6 h-6 mb-2 mx-auto opacity-50"></i><p>已加载 ${count} 个频道，请选择频道预览</p>`;
        lucide.createIcons();
    }
    renderPreview();
}

function renderPreview() {
    if (!channels.length) return;
    const groupsSet = new Set();
    channels.forEach(ch => { if(ch.group) groupsSet.add(ch.group); });
    let keys = Array.from(groupsSet).sort();
    keys.push('全部');
    if (!currentGroup) currentGroup = keys[0];

    const gc = document.getElementById('groupContainer');
    gc.innerHTML = '';
    keys.forEach(g => {
        const btn = document.createElement('button');
        btn.className = `group-tag px-4 py-2 text-xs font-bold whitespace-nowrap rounded-lg transition-all border ${currentGroup === g ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-slate-400 border-slate-200'}`;
        btn.textContent = g;
        btn.onclick = () => { currentGroup = g; renderPreview(); };
        gc.appendChild(btn);
    });

    const grid = document.getElementById('channelGrid');
    grid.innerHTML = '';
    const filtered = currentGroup === '全部' ? channels : channels.filter(c => c.group === currentGroup);
    filtered.forEach(ch => {
        const b = document.createElement('div');
        b.className = 'channel-btn p-3 bg-white border border-slate-100 rounded-xl hover:border-indigo-400 hover:shadow-sm cursor-pointer transition-all flex items-center gap-3 overflow-hidden';
        b.innerHTML = `<img src="${ch.logo || ''}" class="w-8 h-8 object-contain shrink-0" onerror="this.src='/static/logo.png'"><span class="text-[11px] font-bold truncate">${ch.name}</span>`;
        b.onclick = () => play(ch);
        grid.appendChild(b);
    });
}

function play(ch) {
    const container = document.getElementById('playerContainer');
    // 销毁旧实例并完全清空容器
    if (artPlayer) {
        artPlayer.destroy(true); // 传入 true 表示完全销毁 DOM
        artPlayer = null;
    }
    container.innerHTML = ''; 

    artPlayer = new Artplayer({
        container: container,
        url: `/stream/${ch.id}/index.m3u8`,
        isLive: true,
        autoplay: true,
        theme: '#4f46e5',
        fullscreen: true,
        fullscreenWeb: true,
        setting: true,
        customType: {
            m3u8: function(video, url, art) {
                if (Hls.isSupported()) {
                    if (art.hls) art.hls.destroy();
                    const hls = new Hls();
                    hls.loadSource(url);
                    hls.attachMedia(video);
                    art.hls = hls; // 将 hls 实例挂载到 art 上方便后续销毁
                    art.on('destroy', () => hls.destroy());
                } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
                    video.src = url;
                }
            }
        }
    });
}

function switchTab(t) {
    const isC = t === 'console';
    document.getElementById('consolePage').classList.toggle('hidden', !isC);
    document.getElementById('previewPage').classList.toggle('hidden', isC);
    document.getElementById('tabConsole').className = isC ? 'font-bold py-2 active-tab text-sm' : 'font-bold py-2 text-slate-400 text-sm';
    document.getElementById('tabPreview').className = !isC ? 'font-bold py-2 active-tab text-sm' : 'font-bold py-2 text-slate-400 text-sm';
}

document.getElementById('tabConsole').onclick = () => switchTab('console');
document.getElementById('tabPreview').onclick = () => switchTab('preview');

document.getElementById('copyBtn').onclick = () => {
    const val = document.getElementById('m3uUrl').value;
    if (!val || val.includes("等待")) return;
    const btn = document.getElementById('copyBtn');
    const success = () => {
        btn.textContent = '已复制';
        setTimeout(() => btn.textContent = '复制', 2000);
    };
    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(val).then(success);
    } else {
        const textArea = document.createElement("textarea");
        textArea.value = val;
        textArea.style.position = "fixed";
        textArea.style.left = "-9999px";
        textArea.style.top = "0";
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        try { document.execCommand('copy'); success(); } catch (err) { console.error('Fallback copy failed', err); }
        document.body.removeChild(textArea);
    }
};

async function checkStatus() {
    try {
        const r = await fetch('/api/status?t=' + Date.now());
        if (r.ok) {
            const d = await r.json();
            document.getElementById('processCount').textContent = d.active_count;
        }
    } catch(e) {}
}

window.onload = () => { init(); checkStatus(); setInterval(checkStatus, 3000); };