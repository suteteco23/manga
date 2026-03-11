
        /** Constants */
        const CONFIG = {
            EXTENSIONS: /\.(jpe?g|png|gif|webp)$/i,
            ZIP_EXT: /\.zip$/i,
            MAX_ZIP: 2048 * 1024 * 1024,  // 2GB (遅延ロードにより緩和)
            WARNING_ZIP: 1024 * 1024 * 1024,  // 1GB
            KEYS: {
                NEXT: ['ArrowRight', ' '],
                PREV: ['ArrowLeft'],
                FS: ['f'],
                ESC: ['Escape'],
                HOME: ['Home'],
                END: ['End'],
                HELP: ['?'],
                RESET: ['r'],
                SINGLE: ['1'],
                DOUBLE: ['2']
            },
            WHEEL_THROTTLE: 500,
            CLICK_DELAY: 250,
            PRELOAD_COUNT: 4,
            MEMORY_WINDOW: 10 // 前後この範囲外のメモリを開放
        };

        /** Utility Functions */
        const Utils = {
            formatFileSize(bytes) {
                if (bytes === 0) return '0 Bytes';
                const k = 1024;
                const sizes = ['Bytes', 'KB', 'MB', 'GB'];
                const i = Math.floor(Math.log(bytes) / Math.log(k));
                return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
            },
            
            throttle(func, limit) {
                let inThrottle;
                return function(...args) {
                    if (!inThrottle) {
                        func.apply(this, args);
                        inThrottle = true;
                        setTimeout(() => inThrottle = false, limit);
                    }
                };
            },

            debounce(func, wait) {
                let timeout;
                return function(...args) {
                    clearTimeout(timeout);
                    timeout = setTimeout(() => func.apply(this, args), wait);
                };
            },

            sortByName(a, b) {
                return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
            }
        };

        /** Service: Image Item Wrapper (Lazy Load) */
        class ImageItem {
            constructor(name, source, type) {
                this.name = name;
                this.source = source; // File object or JSZipObject
                this.type = type;     // 'file' or 'zip'
                this.url = null;
                this.loadPromise = null;
            }

            async getUrl() {
                if (this.url) return this.url;
                if (this.loadPromise) return this.loadPromise;

                this.loadPromise = (async () => {
                    try {
                        const blob = this.type === 'zip' 
                            ? await this.source.async('blob') 
                            : this.source;
                        this.url = URL.createObjectURL(blob);
                        return this.url;
                    } catch (e) {
                        console.error('Failed to load:', this.name, e);
                        return null;
                    } finally {
                        this.loadPromise = null;
                    }
                })();
                return this.loadPromise;
            }

            unload() {
                if (this.url) {
                    URL.revokeObjectURL(this.url);
                    this.url = null;
                }
            }
        }

        /** Service: File Loader */
        class FileLoader {
            static async loadZip(file, onProgress) {
                if (file.size > CONFIG.MAX_ZIP) {
                    throw new Error(`ファイルが大きすぎます。最大: ${Utils.formatFileSize(CONFIG.MAX_ZIP)}`);
                }
                if (file.size > CONFIG.WARNING_ZIP) {
                    const proceed = confirm(
                        `ファイルサイズが大きいです (${Utils.formatFileSize(file.size)})。
` +
                        `読み込みに時間がかかる場合があります。続行しますか?`
                    );
                    if (!proceed) throw new Error('キャンセルされました');
                }

                onProgress?.(10, 'ZIP解析中...');
                const zip = await JSZip.loadAsync(file);
                
                onProgress?.(50, 'ファイル一覧を作成中...');
                const files = Object.values(zip.files)
                    .filter(e => !e.dir && CONFIG.EXTENSIONS.test(e.name) && !e.name.startsWith('__MACOSX'))
                    .sort((a, b) => Utils.sortByName(a.name, b.name));

                const items = files.map(f => new ImageItem(f.name, f, 'zip'));
                onProgress?.(100, '完了');
                
                return { items };
            }

            static async loadInputFiles(fileList) {
                const files = Array.from(fileList)
                    .filter(f => CONFIG.EXTENSIONS.test(f.name))
                    .sort((a, b) => Utils.sortByName(
                        a.webkitRelativePath || a.name,
                        b.webkitRelativePath || a.name
                    ));
                return { items: files.map(f => new ImageItem(f.name, f, 'file')) };
            }

            static async loadFromDirectory(dirHandle) {
                const entries = [];
                for await (const entry of dirHandle.values()) {
                    if (entry.kind === 'file' && CONFIG.EXTENSIONS.test(entry.name)) {
                        entries.push(await entry.getFile());
                    }
                }
                entries.sort((a, b) => Utils.sortByName(a.name, b.name));
                return { items: entries.map(f => new ImageItem(f.name, f, 'file')) };
            }

            static async loadFromDroppedFolder(dirEntry) {
                const imageFiles = [];

                async function readDirectory(dirEntry) {
                    const reader = dirEntry.createReader();
                    let entries = [];
                    let batch;
                    do {
                        batch = await new Promise((resolve, reject) => {
                            reader.readEntries(resolve, reject);
                        });
                        entries = entries.concat(batch);
                    } while (batch.length > 0);

                    for (const entry of entries) {
                        if (entry.isFile && CONFIG.EXTENSIONS.test(entry.name)) {
                            const file = await new Promise((resolve, reject) => {
                                entry.file(resolve, reject);
                            });
                            imageFiles.push(file);
                        } else if (entry.isDirectory) {
                            await readDirectory(entry);
                        }
                    }
                }

                await readDirectory(dirEntry);
                imageFiles.sort((a, b) => Utils.sortByName(a.name, b.name));
                return { items: imageFiles.map(f => new ImageItem(f.name, f, 'file')) };
            }
        }

        /** State Manager */
        class ViewerState {
            constructor() {
                this.listeners = [];
                this.data = {
                    items: [],
                    index: 0,
                    mode: 'single',
                    order: 'left',
                    interval: 3000,
                    isPlaying: false,
                    isFullscreen: false
                };
            }

            subscribe(fn) { this.listeners.push(fn); }
            _notify() { this.listeners.forEach(fn => fn(this.data)); }

            get current() { return this.data.items[this.data.index]; }
            get total() { return this.data.items.length; }
            get hasItems() { return this.total > 0; }

            setItems(items) {
                this.data.items.forEach(i => i.unload());
                this.data.items = items;
                this.data.index = 0;
                this.data.isPlaying = false;
                this._notify();
            }

            setIndex(idx) {
                if (!this.hasItems) return;
                const newIdx = Math.max(0, Math.min(idx, this.total - 1));
                if (this.data.index !== newIdx) {
                    this.data.index = newIdx;
                    this._notify();
                    this._manageMemory();
                }
            }

            setSetting(key, value) {
                if (this.data[key] !== value) {
                    this.data[key] = value;
                    if (key === 'mode' && value === 'double' && this.data.index > 0 && this.data.index % 2 !== 0) {
                        this.data.index--;
                    }
                    this._notify();
                }
            }

            setFullscreen(isFs) {
                if(this.data.isFullscreen !== isFs) {
                    this.data.isFullscreen = isFs;
                    this._notify();
                }
            }

            togglePlay() {
                this.data.isPlaying = !this.data.isPlaying;
                this._notify();
            }

            reset() {
                this.setItems([]);
            }

            _manageMemory() {
                if (!this.hasItems) return;
                
                const currentIndex = this.data.index;
                const preload = CONFIG.PRELOAD_COUNT;
                const windowSize = CONFIG.MEMORY_WINDOW;

                // 1. プリロード範囲の特定（ロード対象）
                const loadStart = Math.max(0, currentIndex - preload);
                const loadEnd = Math.min(this.total, currentIndex + preload + (this.data.mode === 'double' ? 2 : 1));
                
                // 2. メモリ保持範囲の特定（これ以外は開放）
                const keepStart = Math.max(0, currentIndex - windowSize);
                const keepEnd = Math.min(this.total, currentIndex + windowSize);

                // 3. 実行
                this.data.items.forEach((item, idx) => {
                    if (idx >= loadStart && idx < loadEnd) {
                        item.getUrl(); // プリロード発火
                    } else if (idx < keepStart || idx >= keepEnd) {
                        item.unload(); // メモリ開放
                    }
                });
            }
        }

        /** UI Manager */
        class UIManager {
            constructor(state) {
                this.state = state;
                this.els = this._cacheElements();
                this.isSliderDragging = false;
                this.state.subscribe(data => this.render(data));
                this._loadSettings();
            }

            _cacheElements() {
                const id = (i) => document.getElementById(i);
                return {
                    container: id('imageContainer'),
                    host: id('imageContainerHost'),
                    placeholder: id('placeholder'),
                    loader: id('loader'),
                    progress: id('progressBar'),
                    loaderText: id('loaderText'),
                    navBar: id('navBar'),
                    slider: id('pageSlider'),
                    pageCur: id('pageCurrent'),
                    pageTot: id('pageTotal'),
                    prevBtn: id('prevBtn'),
                    nextBtn: id('nextBtn'),
                    playBtn: id('btnAutoPlay'),
                    fsBtn: id('btnFullscreen'),
                    tree: id('treeContainer'),
                    sidebar: id('sidebarPanel'),
                    resizeHandle: id('resizeHandle'),
                    grpView: id('grpViewMode'),
                    grpOrder: id('grpPageOrder'),
                    grpInt: id('grpInterval'),
                    orderCtrl: id('ctrlPageOrder')
                };
            }

            _loadSettings() {
                try {
                    const saved = JSON.parse(localStorage.getItem('viewer_settings') || '{}');
                    if (saved.mode) this.state.setSetting('mode', saved.mode);
                    if (saved.order) this.state.setSetting('order', saved.order);
                    if (saved.interval) this.state.setSetting('interval', saved.interval);
                    const w = localStorage.getItem('sidebar_width');
                    if(w) this.els.sidebar.style.width = w + 'px';
                } catch(e){}
            }

            setLoading(isLoading, text = 'Loading...') {
                this.els.loader.classList.toggle('hidden', !isLoading);
                if(isLoading) {
                    this.els.loaderText.textContent = text;
                    this.els.progress.style.width = '0%';
                }
            }

            updateProgress(val, text) {
                this.els.progress.style.width = `${val}%`;
                if (text) this.els.loaderText.textContent = text;
            }

            render(data) {
                const { items, index, mode, order, isPlaying, isFullscreen } = data;
                const hasItems = items.length > 0;

                this.els.placeholder.classList.toggle('hidden', hasItems);
                this.els.container.classList.toggle('hidden', !hasItems);
                this.els.navBar.classList.toggle('hidden', !hasItems);
                this.els.orderCtrl.classList.toggle('hidden', mode !== 'double');

                this._updateBtnGroup(this.els.grpView, mode);
                this._updateBtnGroup(this.els.grpOrder, order);
                this._updateBtnGroup(this.els.grpInt, data.interval);
                
                this.els.playBtn.textContent = isPlaying ? '■ 停止' : '▶ 再生開始';
                this.els.playBtn.classList.toggle('btn-primary', isPlaying);

                document.body.classList.toggle('fullscreen-mode', isFullscreen);
                this.els.fsBtn.textContent = isFullscreen ? '⛶ 解除' : '⛶ フルスクリーン';

                if (!hasItems) return;

                // 画像描画
                this.els.container.className = `image-container ${mode === 'double' ? 'double-page' : ''}`;
                this.els.container.innerHTML = '';
                const indices = this._getIndices(index, items.length, mode, order);
                indices.forEach(i => {
                    const div = document.createElement('div');
                    div.className = 'image-wrapper';
                    if (i < items.length) {
                        const item = items[i];
                        const img = document.createElement('img');
                        img.alt = item.name;
                        // 非同期ロード
                        item.getUrl().then(url => {
                            if(url) img.src = url;
                        });
                        div.appendChild(img);
                    }
                    this.els.container.appendChild(div);
                });

                // ページ情報更新
                this.els.pageCur.textContent = indices.map(i => i + 1).join('-');
                this.els.pageTot.textContent = items.length;

                // スライダー更新（右綴じ対応）
                if (!this.isSliderDragging) {
                    const step = mode === 'double' ? 2 : 1;
                    const max = Math.max(0, items.length - step);
                    this.els.slider.max = max;
                    this.els.slider.step = 1;
                    
                    let sliderVal = index;
                    if (mode === 'double' && order === 'right') {
                        sliderVal = max - index;
                    }
                    this.els.slider.value = sliderVal;
                }

                // ボタンラベル更新（右綴じ対応）
                const isRTL = (mode === 'double' && order === 'right');
                this.els.prevBtn.textContent = isRTL ? '次へ (→)' : '← 前へ';
                this.els.nextBtn.textContent = isRTL ? '前へ (←)' : '次へ →';
            }

            _getIndices(current, total, mode, order) {
                if (mode !== 'double') return [current];
                const p1 = current;
                const p2 = current + 1;
                return order === 'right' ? [p2, p1] : [p1, p2];
            }

            _updateBtnGroup(group, activeVal) {
                Array.from(group.children).forEach(btn => {
                    btn.classList.toggle('active', btn.dataset.val == activeVal);
                });
            }

            showModal(title, content) {
                const modal = document.createElement('div');
                modal.className = 'modal-overlay';
                
                const dialog = document.createElement('div');
                dialog.className = 'modal-content';
                dialog.innerHTML = `
                    <h2 style="font-size: 1.5rem; font-weight: bold; margin-bottom: 1.5rem; color: #374151;">${title}</h2>
                    ${content}
                    <button class="btn btn-primary mt-4">閉じる</button>
                `;
                
                modal.appendChild(dialog);
                document.body.appendChild(modal);
                
                const close = () => document.body.removeChild(modal);
                dialog.querySelector('.btn').onclick = close;
                modal.onclick = (e) => { if (e.target === modal) close(); };
                
                const escHandler = (e) => {
                    if (e.key === 'Escape') {
                        close();
                        document.removeEventListener('keydown', escHandler);
                    }
                };
                document.addEventListener('keydown', escHandler);
            }
        }

        /** Main Controller */
        class App {
            constructor() {
                this.state = new ViewerState();
                this.ui = new UIManager(this.state);
                this.timer = null;
                this.clickTimer = null;
                this._initEvents();
                this._initResizer();
            }

            _initEvents() {
                const { ui, state } = this;

                // キーボード操作（右綴じ対応）
                document.addEventListener('keydown', e => {
                    if (e.target.tagName === 'INPUT') return;
                    const k = e.key;
                    
                    // ヘルプ表示
                    if (CONFIG.KEYS.HELP.includes(k)) {
                        e.preventDefault();
                        this._showHelp();
                        return;
                    }
                    
                    // リセット
                    if (CONFIG.KEYS.RESET.includes(k)) {
                        e.preventDefault();
                        if (confirm('ビューアーをリセットしますか？')) state.reset();
                        return;
                    }
                    
                    // 表示モード切替
                    if (CONFIG.KEYS.SINGLE.includes(k)) {
                        state.setSetting('mode', 'single');
                        this._saveSettings();
                        return;
                    }
                    if (CONFIG.KEYS.DOUBLE.includes(k)) {
                        state.setSetting('mode', 'double');
                        this._saveSettings();
                        return;
                    }
                    
                    if (!state.hasItems) return;
                    
                    // Shiftキー押下で1ページずつ移動
                    const step = (state.data.mode === 'double' && !e.shiftKey) ? 2 : 1;
                    const isRTL = (state.data.mode === 'double' && state.data.order === 'right');
                    const dirNext = isRTL ? -1 : 1;

                    if (CONFIG.KEYS.NEXT.includes(k)) {
                        e.preventDefault();
                        this._move(step * dirNext);
                    }
                    if (CONFIG.KEYS.PREV.includes(k)) {
                        e.preventDefault();
                        this._move(-step * dirNext);
                    }
                    if (CONFIG.KEYS.HOME.includes(k)) {
                        e.preventDefault();
                        state.setIndex(0);
                    }
                    if (CONFIG.KEYS.END.includes(k)) {
                        e.preventDefault();
                        const endStep = state.data.mode === 'double' ? 2 : 1;
                        state.setIndex(Math.max(0, state.total - endStep));
                    }
                    if (CONFIG.KEYS.FS.includes(k)) {
                        e.preventDefault();
                        this._toggleFullscreen();
                    }
                    if (CONFIG.KEYS.ESC.includes(k) && document.fullscreenElement) {
                        document.exitFullscreen();
                    }
                });

                // ホイール操作（右綴じ対応）
                const wheelHandler = Utils.throttle((e) => {
                    if (!state.hasItems) return;
                    e.preventDefault();
                    
                    const dir = e.deltaY > 0 ? 1 : -1;
                    const step = state.data.mode === 'double' ? 2 : 1;
                    const isRTL = (state.data.mode === 'double' && state.data.order === 'right');
                    this._move(dir * step * (isRTL ? -1 : 1));
                }, CONFIG.WHEEL_THROTTLE);

                ui.els.host.addEventListener('wheel', wheelHandler, { passive: false });

                // クリック/ダブルクリック
                ui.els.host.addEventListener('click', e => {
                    if (!state.hasItems) return;
                    if (this.clickTimer) clearTimeout(this.clickTimer);
                    this.clickTimer = setTimeout(() => {
                        this._handleSingleClick(e);
                        this.clickTimer = null;
                    }, CONFIG.CLICK_DELAY);
                });

                ui.els.host.addEventListener('dblclick', () => {
                    if (this.clickTimer) {
                        clearTimeout(this.clickTimer);
                        this.clickTimer = null;
                    }
                    this._toggleFullscreen();
                });

                // フルスクリーン同期
                const syncFs = () => state.setFullscreen(!!document.fullscreenElement);
                document.addEventListener('fullscreenchange', syncFs);
                document.addEventListener('webkitfullscreenchange', syncFs);

                // スライダー（右綴じ対応）
                const slider = ui.els.slider;
                slider.addEventListener('mousedown', () => ui.isSliderDragging = true);
                slider.addEventListener('mouseup', () => ui.isSliderDragging = false);
                slider.addEventListener('touchstart', () => ui.isSliderDragging = true);
                slider.addEventListener('touchend', () => ui.isSliderDragging = false);
                slider.addEventListener('input', (e) => {
                    if (state.data.isPlaying) this._stopAutoPlay();
                    let val = parseInt(e.target.value, 10);
                    
                    if (state.data.mode === 'double' && state.data.order === 'right') {
                        val = parseInt(slider.max, 10) - val;
                    }
                    state.setIndex(val);
                });

                // UIボタン
                document.getElementById('btnSelectFile').onclick = () => {
                    this._showFileSelectionDialog();
                };
                
                document.getElementById('fileInput').onchange = (e) => {
                    if (e.target.files[0]) this._loadZip(e.target.files[0]);
                    e.target.value = '';
                };
                
                document.getElementById('folderInput').onchange = async (e) => {
                    if (e.target.files && e.target.files.length > 0) {
                        await this._loadFiles(e.target.files);
                    }
                    e.target.value = '';
                };
                
                document.getElementById('btnOpenFolder').onclick = () => this._browseDir();

                const bindGroup = (el, key) => {
                    el.onclick = (e) => {
                        const btn = e.target.closest('button');
                        if (btn) {
                            state.setSetting(key, btn.dataset.val);
                            this._saveSettings();
                        }
                    };
                };
                bindGroup(ui.els.grpView, 'mode');
                bindGroup(ui.els.grpOrder, 'order');
                
                ui.els.grpInt.onclick = (e) => {
                    const btn = e.target.closest('button');
                    if(btn) {
                        state.setSetting('interval', parseInt(btn.dataset.val));
                        this._saveSettings();
                    }
                };

                ui.els.prevBtn.onclick = () => {
                    const step = state.data.mode === 'double' ? 2 : 1;
                    const isRTL = state.data.mode === 'double' && state.data.order === 'right';
                    this._move(-step * (isRTL ? -1 : 1));
                };
                
                ui.els.nextBtn.onclick = () => {
                    const step = state.data.mode === 'double' ? 2 : 1;
                    const isRTL = state.data.mode === 'double' && state.data.order === 'right';
                    this._move(step * (isRTL ? -1 : 1));
                };
                
                ui.els.playBtn.onclick = () => {
                    state.togglePlay();
                    state.data.isPlaying ? this._startAutoPlay() : this._stopAutoPlay();
                };
                
                ui.els.fsBtn.onclick = () => this._toggleFullscreen();
                
                document.getElementById('btnReset').onclick = () => {
                    if(confirm('リセットしますか？')) state.reset();
                };
                
                document.getElementById('btnHelp').onclick = () => this._showHelp();

                // D&D
                const dropZone = document.getElementById('dropZone');
                dropZone.ondragover = (e) => {
                    e.preventDefault();
                    dropZone.classList.add('dragging');
                };
                dropZone.ondragleave = () => dropZone.classList.remove('dragging');
                dropZone.ondrop = (e) => {
                    e.preventDefault();
                    dropZone.classList.remove('dragging');
                    this._handleDrop(e.dataTransfer);
                };

                state.subscribe(d => this._saveSettings());
            }

            _handleSingleClick(e) {
                const rect = this.ui.els.host.getBoundingClientRect();
                const isLeft = e.clientX < rect.left + rect.width / 2;
                const isRTL = this.state.data.mode === 'double' && this.state.data.order === 'right';
                
                const dir = isLeft ? -1 : 1;
                const step = this.state.data.mode === 'double' ? 2 : 1;
                this._move(dir * step * (isRTL ? -1 : 1));
            }

            _move(dir) {
                this.state.setIndex(this.state.data.index + dir);
            }

            _startAutoPlay() {
                if(this.timer) clearInterval(this.timer);
                this.timer = setInterval(() => {
                    const step = this.state.data.mode === 'double' ? 2 : 1;
                    if (this.state.data.index >= this.state.total - step) {
                        this.state.togglePlay();
                        this._stopAutoPlay();
                    } else {
                        this._move(step);
                    }
                }, this.state.data.interval);
            }

            _stopAutoPlay() {
                clearInterval(this.timer);
                this.timer = null;
                if(this.state.data.isPlaying) this.state.togglePlay();
            }

            _toggleFullscreen() {
                if (!document.fullscreenElement) {
                    document.getElementById('mainArea').requestFullscreen().catch(()=>{});
                } else {
                    document.exitFullscreen().catch(()=>{});
                }
            }

            async _loadZip(file) {
                this.ui.setLoading(true, 'ZIP読み込み中...');
                try {
                    const res = await FileLoader.loadZip(file, (p, t) => this.ui.updateProgress(p, t));
                    this.state.setItems(res.items);
                } catch (e) {
                    console.error(e);
                    alert(e.message || 'ZIP読み込みエラー');
                } finally {
                    this.ui.setLoading(false);
                }
            }

            async _loadFiles(files) {
                this.ui.setLoading(true, '処理中...');
                try {
                    const res = await FileLoader.loadInputFiles(files);
                    this.state.setItems(res.items);
                } catch (e) {
                    alert('エラー');
                } finally {
                    this.ui.setLoading(false);
                }
            }

            async _browseDir() {
                try {
                    const handle = await window.showDirectoryPicker();
                    this._buildTree(handle);
                } catch (e) {}
            }

            async _handleDrop(dt) {
                const item = dt.items[0];
                const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
                
                if (entry) {
                    if (entry.isDirectory) {
                        this.ui.setLoading(true, 'フォルダ解析中...');
                        try {
                            const res = await FileLoader.loadFromDroppedFolder(entry);
                            if(res.items.length) this.state.setItems(res.items);
                            else alert('画像なし');
                        } catch(e) {
                            console.error(e);
                        } finally {
                            this.ui.setLoading(false);
                        }
                    } else if (CONFIG.ZIP_EXT.test(entry.name)) {
                        this._loadZip(item.getAsFile());
                    }
                } else {
                    const file = item.getAsFile();
                    if (file && CONFIG.ZIP_EXT.test(file.name)) {
                        this._loadZip(file);
                    }
                }
            }

            async _buildTree(rootHandle) {
                const container = this.ui.els.tree;
                container.innerHTML = '';
                
                const createNode = (name, icon, onClick) => {
                    const div = document.createElement('div');
                    div.className = `tree-item ${icon === 'folder' ? 'icon-folder' : 'icon-zip'}`;
                    const span = document.createElement('span');
                    span.className = 'truncate';
                    span.textContent = name;
                    div.appendChild(span);
                    div.onclick = (e) => {
                        e.stopPropagation();
                        document.querySelectorAll('.tree-item.active').forEach(el=>el.classList.remove('active'));
                        div.classList.add('active');
                        onClick(div);
                    };
                    return div;
                };
                
                const renderDir = async (handle, parentEl) => {
                    const ul = document.createElement('ul');
                    const entries = [];
                    for await (const e of handle.values()) entries.push(e);
                    entries.sort((a,b) => (a.kind===b.kind ? Utils.sortByName(a.name, b.name) : (a.kind==='directory'?-1:1)));
                    
                    for (const entry of entries) {
                        const li = document.createElement('li');
                        if (entry.kind === 'directory') {
                            li.className = 'tree-folder';
                            li.appendChild(createNode(entry.name, 'folder', async () => {
                                li.classList.toggle('open');
                                const res = await FileLoader.loadFromDirectory(entry);
                                this.state.setItems(res.items);
                            }));
                            await renderDir(entry, li);
                        } else if (CONFIG.ZIP_EXT.test(entry.name)) {
                            li.appendChild(createNode(entry.name, 'zip', async () => {
                                const f = await entry.getFile();
                                this._loadZip(f);
                            }));
                        }
                        if(li.hasChildNodes()) ul.appendChild(li);
                    }
                    parentEl.appendChild(ul);
                };
                
                const root = document.createElement('div');
                root.className = 'tree-folder open';
                root.appendChild(createNode(rootHandle.name, 'folder', ()=>{}));
                container.appendChild(root);
                renderDir(rootHandle, root);
            }

            _initResizer() {
                const h = this.ui.els.resizeHandle, p = this.ui.els.sidebar;
                h.onmousedown = e => {
                    e.preventDefault();
                    const mv = em => p.style.width = Math.max(150,Math.min(600,em.clientX))+'px';
                    const up = () => {
                        document.removeEventListener('mousemove',mv);
                        document.removeEventListener('mouseup',up);
                        localStorage.setItem('sidebar_width',p.offsetWidth);
                    };
                    document.addEventListener('mousemove',mv);
                    document.addEventListener('mouseup',up);
                };
            }

            _saveSettings() {
                localStorage.setItem('viewer_settings', JSON.stringify({
                    mode: this.state.data.mode,
                    order: this.state.data.order,
                    interval: this.state.data.interval
                }));
            }

            _showFileSelectionDialog() {
                const modal = document.createElement('div');
                modal.className = 'modal-overlay';
                
                const dialog = document.createElement('div');
                dialog.className = 'modal-content';
                dialog.style.maxWidth = '400px';
                dialog.innerHTML = `
                    <h3 style="font-size: 1.25rem; font-weight: bold; margin-bottom: 1rem; color: #374151;">ファイルタイプを選択</h3>
                    <div style="display: flex; flex-direction: column; gap: 0.75rem;">
                        <button id="selectZipBtn" class="btn btn-primary">ZIPファイルを選択</button>
                        <button id="selectFolderBtn" class="btn btn-primary">フォルダを選択</button>
                        <button id="cancelBtn" class="btn">キャンセル</button>
                    </div>
                `;
                
                modal.appendChild(dialog);
                document.body.appendChild(modal);
                
                const close = () => document.body.removeChild(modal);
                
                dialog.querySelector('#selectZipBtn').onclick = () => {
                    close();
                    document.getElementById('fileInput').click();
                };
                
                dialog.querySelector('#selectFolderBtn').onclick = () => {
                    close();
                    document.getElementById('folderInput').click();
                };
                
                dialog.querySelector('#cancelBtn').onclick = close;
                modal.onclick = (e) => { if (e.target === modal) close(); };
                
                const escHandler = (e) => {
                    if (e.key === 'Escape') {
                        close();
                        document.removeEventListener('keydown', escHandler);
                    }
                };
                document.addEventListener('keydown', escHandler);
            }

            _showHelp() {
                const shortcuts = [
                    { category: 'ナビゲーション', items: [
                        { key: '← / →', desc: 'ページ移動（見開き時は2ページ）' },
                        { key: 'Shift + ← / →', desc: '1ページずつ移動' },
                        { key: 'Home', desc: '最初のページへ' },
                        { key: 'End', desc: '最後のページへ' },
                        { key: 'Space', desc: 'ページ移動（次へ）' }
                    ]},
                    { category: '表示モード', items: [
                        { key: '1', desc: '単一ページ表示' },
                        { key: '2', desc: '見開き表示' },
                        { key: 'F', desc: 'フルスクリーン切替' },
                        { key: 'Esc', desc: 'フルスクリーン解除' }
                    ]},
                    { category: '操作', items: [
                        { key: 'R', desc: 'ビューアーをリセット' },
                        { key: '?', desc: 'このヘルプを表示' },
                        { key: 'クリック', desc: 'ページ送り（左右判定）' },
                        { key: 'ダブルクリック', desc: 'フルスクリーン切替' },
                        { key: 'ホイール', desc: 'ページ移動' }
                    ]}
                ];

                let content = '';
                shortcuts.forEach(section => {
                    content += `<h3 style="font-size: 1.125rem; font-weight: 600; margin-top: 1rem; margin-bottom: 0.75rem; color: #1f2937;">${section.category}</h3>`;
                    content += '<table style="width: 100%; border-collapse: collapse; margin-bottom: 1rem;">';
                    section.items.forEach(item => {
                        content += `
                            <tr style="border-bottom: 1px solid #e5e7eb;">
                                <td style="padding: 0.5rem; font-weight: 600; font-family: monospace; background: #f3f4f6; border-radius: 0.25rem; width: 35%;">${item.key}</td>
                                <td style="padding: 0.5rem; padding-left: 1rem;">${item.desc}</td>
                            </tr>
                        `;
                    });
                    content += '</table>';
                });

                content += '<p style="margin-top: 1rem; font-size: 0.875rem; color: #6b7280;"><strong>※ 右綴じモード:</strong> 矢印キー・ホイール・クリック判定がすべて反転します</p>';

                this.ui.showModal('キーボードショートカット', content);
            }
        }

        window.onload = () => new App();
    