/**
 * Channel List Component
 * Handles the sidebar channel list
 */

class ChannelList {
    constructor() {
        this.container = document.getElementById('channel-list');
        this.searchInput = document.getElementById('channel-search');
        this.sourceSelect = document.getElementById('source-select');
        this.showHiddenCheckbox = document.getElementById('show-hidden');
        this.contextMenu = document.getElementById('context-menu');

        this.channels = [];
        this.groups = [];
        this.hiddenItems = new Set(); // Set<"type:sourceId:itemId">
        this.collapsedGroups = new Set(); // Track collapsed groups
        this.favorites = []; // Array of favorite objects
        this.visibleFavorites = new Set(); // Set<"sourceId:channelId">
        this.currentChannel = null;
        this.sources = [];
        this.isLoading = false;

        this.loadCollapsedState();
        this.init();
    }

    /**
     * Load collapsed state from localStorage
     */
    loadCollapsedState() {
        try {
            const saved = localStorage.getItem('nodecast_tv_collapsed_groups');
            if (saved) {
                this.collapsedGroups = new Set(JSON.parse(saved));
            }
        } catch (err) {
            console.error('Error loading collapsed state:', err);
        }
    }

    /**
     * Save collapsed state to localStorage
     */
    saveCollapsedState() {
        try {
            localStorage.setItem('nodecast_tv_collapsed_groups', JSON.stringify([...this.collapsedGroups]));
        } catch (err) {
            console.error('Error saving collapsed state:', err);
        }
    }

    /**
     * Toggle group collapsed state
     */
    toggleGroup(groupName) {
        if (this.collapsedGroups.has(groupName)) {
            this.collapsedGroups.delete(groupName);
        } else {
            this.collapsedGroups.add(groupName);
        }
        this.saveCollapsedState();
    }

    /**
     * Expand all groups
     */
    expandAll() {
        this.collapsedGroups.clear();
        this.saveCollapsedState();
        this.container.querySelectorAll('.group-header.collapsed').forEach(h => h.classList.remove('collapsed'));
    }

    /**
     * Collapse all groups
     */
    collapseAll() {
        this.container.querySelectorAll('.group-header').forEach(h => {
            const groupName = h.dataset.group;
            this.collapsedGroups.add(groupName);
            h.classList.add('collapsed');
        });
        this.saveCollapsedState();
    }

    /**
     * Toggle between expand/collapse all
     */
    toggleAllGroups() {
        const allHeaders = this.container.querySelectorAll('.group-header');
        const allCollapsed = [...allHeaders].every(h => h.classList.contains('collapsed'));

        if (allCollapsed) {
            this.expandAll();
        } else {
            this.collapseAll();
        }
    }

    init() {
        // Search handler (debounced)
        let searchTimeout;
        this.searchInput.addEventListener('input', () => {
            clearTimeout(searchTimeout);
            searchTimeout = setTimeout(() => {
                this.render();
            }, 300);
        });

        // Source filter handler
        this.sourceSelect.addEventListener('change', () => this.loadChannels());

        // Show hidden toggle
        if (this.showHiddenCheckbox) {
            this.showHiddenCheckbox.addEventListener('change', () => this.render());
        }

        // Context menu handlers
        document.addEventListener('click', () => this.hideContextMenu());

        this.contextMenu.querySelectorAll('.context-item').forEach(item => {
            item.addEventListener('click', (e) => this.handleContextAction(e));
        });

        // Intersection Observer for lazy loading
        this.observer = new IntersectionObserver((entries) => {
            if (entries[0].isIntersecting) {
                this.renderNextBatch();
            }
        }, { rootMargin: '100px' });
    }

    // ... (loadSources, loadChannels, loadAllChannels, loadXtreamChannels, loadM3uChannels, loadHiddenItems, isHidden, loadFavorites, isFavorite, toggleFavorite methods remain same)

    /**
     * Get current program info string
     */
    getProgramInfo(channel) {
        try {
            if (!window.app || !window.app.epgGuide) return null;
            const program = window.app.epgGuide.getCurrentProgram(channel.tvgId, channel.name);
            return program ? program.title : null;
        } catch (e) {
            console.warn("Error in getProgramInfo", e);
            return null;
        }
    }

    escapeHtml(text) {
        if (!text) return '';
        return text
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    /**
     * Render channel list
     */
    render() {
        const searchTerm = this.searchInput.value.toLowerCase();
        const showHidden = this.showHiddenCheckbox ? this.showHiddenCheckbox.checked : false;

        // Reset batching
        this.currentBatch = 0;
        this.batchSize = 100; // Number of groups to render per batch (increased to handle many hidden groups)
        this.container.innerHTML = ''; // Clear container

        // Filter and Group channels
        const groupedChannels = {};

        // 1. Filter
        this.filteredChannels = this.channels;
        if (searchTerm) {
            this.filteredChannels = this.channels.filter(ch =>
                ch.name.toLowerCase().includes(searchTerm) ||
                (ch.groupTitle && ch.groupTitle.toLowerCase().includes(searchTerm))
            );
        }

        let filteredChannels = this.filteredChannels;

        // 2. Group
        filteredChannels.forEach(ch => {
            const groupKey = ch.groupTitle || 'Uncategorized';
            if (!groupedChannels[groupKey]) {
                groupedChannels[groupKey] = [];
            }
            groupedChannels[groupKey].push(ch);
        });

        // 3. Add Favorites
        const favoritedChannels = this.channels.filter(ch => this.isFavorite(ch.sourceId, ch.id));
        if (favoritedChannels.length > 0) {
            favoritedChannels.sort((a, b) => a.name.localeCompare(b.name));
            groupedChannels['Favorites'] = favoritedChannels;
        }

        // 4. Sort Groups
        this.sortedGroups = Object.keys(groupedChannels).sort((a, b) => {
            if (a === 'Favorites') return -1;
            if (b === 'Favorites') return 1;
            return a.localeCompare(b);
        });

        this.groupedChannels = groupedChannels;
        this.showHidden = showHidden;

        // Empty State
        if (this.sortedGroups.length === 0) {
            this.container.innerHTML = `
        <div class="empty-state">
          <p>${searchTerm ? 'No channels match your search' : 'No channels loaded'}</p>
          <p class="hint">${searchTerm ? 'Try a different search term' : 'Add a source in Settings to get started'}</p>
        </div>
      `;
            return;
        }

        // Wrap container content in a specific list div to append to
        this.listContainer = document.createElement('div');
        this.listContainer.className = 'channel-list-content';
        this.container.appendChild(this.listContainer);

        // Add loader element at bottom
        this.loader = document.createElement('div');
        this.loader.className = 'batch-loader';
        this.loader.innerHTML = '<div class="loading-spinner"></div>';
        this.loader.style.opacity = '0'; // Hide initially
        this.container.appendChild(this.loader);

        // Render initial batches - load enough to create scrollable content
        // With many hidden groups, we may need multiple batches to get enough visible groups
        const maxInitialBatches = 10; // Load up to 200 groups (10 batches x 20 groups)
        for (let i = 0; i < maxInitialBatches; i++) {
            if (this.currentBatch * this.batchSize >= this.sortedGroups.length) break;
            this.renderNextBatch();
        }

        // Start observing loader for additional batches
        this.observer.observe(this.loader);
    }

    /**
     * Render next batch of groups
     */
    renderNextBatch() {
        const start = this.currentBatch * this.batchSize;
        const end = start + this.batchSize;
        const groupsToRender = this.sortedGroups.slice(start, end);

        if (groupsToRender.length === 0) {
            // No more groups
            this.loader.style.display = 'none';
            return;
        }

        this.loader.style.opacity = '1';
        let html = '';

        for (const groupName of groupsToRender) {
            const channels = this.groupedChannels[groupName];
            if (channels.length === 0) continue;

            const isFavoritesGroup = groupName === 'Favorites';
            const groupHidden = !isFavoritesGroup && channels.length > 0 && this.isHidden('group', channels[0].sourceId, groupName);

            if (groupHidden && !this.showHidden) continue;

            html += `
        <div class="channel-group">
          <div class="group-header ${groupHidden ? 'hidden' : ''} ${this.collapsedGroups.has(groupName) ? 'collapsed' : ''} ${isFavoritesGroup ? 'favorites-group' : ''}" data-group="${groupName}">
            <span class="group-toggle">▼</span>
            <span class="group-name">${groupName}</span>
            <span class="group-count">${channels.length}</span>
          </div>
          <div class="group-channels">
      `;

            for (const channel of channels) {
                const channelHidden = !isFavoritesGroup && this.isHidden('channel', channel.sourceId, channel.id);
                if (channelHidden && !this.showHidden) continue;

                const isActive = this.currentChannel?.id === channel.id;
                const isFavorite = this.isFavorite(channel.sourceId, channel.id);

                html += `
          <div class="channel-item ${isActive ? 'active' : ''} ${channelHidden ? 'hidden' : ''}" 
               data-channel-id="${channel.id}"
               data-source-id="${channel.sourceId}"
               data-source-type="${channel.sourceType}"
               data-stream-id="${channel.streamId || ''}"
               data-url="${channel.url || ''}">
            <img class="channel-logo" src="${channel.tvgLogo || '/img/placeholder.png'}" 
                 alt="" onerror="this.src='/img/placeholder.png'">
            <div class="channel-info">
              <div class="channel-name">${this.escapeHtml(channel.name)}</div>
              <div class="channel-program">${this.escapeHtml(this.getProgramInfo(channel) || '')}</div>
            </div>
            <button class="favorite-btn ${isFavorite ? 'active' : ''}" title="${isFavorite ? 'Remove from Favorites' : 'Add to Favorites'}">
              ${isFavorite ? '❤️' : '♡'}
            </button>
          </div>
        `;
            }
            html += '</div></div>';
        }

        // Append to list container
        // Use temp div to parse HTML string
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = html;

        while (tempDiv.firstElementChild) {
            const groupEl = tempDiv.firstElementChild;
            this.attachGroupListeners(groupEl);
            this.listContainer.appendChild(groupEl);
        }

        this.currentBatch++;

        // Hide loader if we might be done (next batch check will confirm)
        if (end >= this.sortedGroups.length) {
            this.loader.style.display = 'none';
        }
    }

    attachGroupListeners(groupEl) {
        const header = groupEl.querySelector('.group-header');
        if (header) {
            header.addEventListener('click', () => {
                header.classList.toggle('collapsed');
                this.toggleGroup(header.dataset.group);
            });
            header.addEventListener('contextmenu', (e) => this.showContextMenu(e, 'group', header.dataset));
        }

        groupEl.querySelectorAll('.channel-item').forEach(item => {
            item.addEventListener('click', (e) => {
                if (e.target.closest('.favorite-btn')) return;
                this.selectChannel(item.dataset);
            });
            item.addEventListener('contextmenu', (e) => this.showContextMenu(e, 'channel', item.dataset));

            const favBtn = item.querySelector('.favorite-btn');
            if (favBtn) {
                favBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.toggleFavorite(parseInt(item.dataset.sourceId), item.dataset.channelId);
                });
            }
        });
    }

    /**
     * Load sources into dropdown
     */
    async loadSources() {
        try {
            this.sources = await API.sources.getAll();
            console.log('[ChannelList] loadSources: Got', this.sources?.length || 0, 'sources');
            this.sourceSelect.innerHTML = '<option value="">All Sources</option>';

            const xtreamSources = this.sources.filter(s => s.type === 'xtream' && s.enabled);
            const m3uSources = this.sources.filter(s => s.type === 'm3u' && s.enabled);

            if (xtreamSources.length > 0) {
                const optgroup = document.createElement('optgroup');
                optgroup.label = 'Xtream';
                xtreamSources.forEach(s => {
                    const option = document.createElement('option');
                    option.value = `xtream:${s.id}`;
                    option.textContent = s.name;
                    optgroup.appendChild(option);
                });
                this.sourceSelect.appendChild(optgroup);
            }

            if (m3uSources.length > 0) {
                const optgroup = document.createElement('optgroup');
                optgroup.label = 'M3U';
                m3uSources.forEach(s => {
                    const option = document.createElement('option');
                    option.value = `m3u:${s.id}`;
                    option.textContent = s.name;
                    optgroup.appendChild(option);
                });
                this.sourceSelect.appendChild(optgroup);
            }
        } catch (err) {
            console.error('Error loading sources:', err);
        }
    }

    /**
     * Load channels from selected source
     */
    async loadChannels() {
        if (this.isLoading) return;
        this.isLoading = true;

        const sourceValue = this.sourceSelect.value;
        const self = this;

        if (!sourceValue) {
            // Load from all sources
            await this.loadAllChannels();
            this.isLoading = false;
            return;
        }

        const [type, id] = sourceValue.split(':');

        try {
            this.container.innerHTML = '<div class="loading"></div>';

            if (type === 'xtream') {
                await this.loadXtreamChannels(parseInt(id));
            } else if (type === 'm3u') {
                await this.loadM3uChannels(parseInt(id));
            }

            // Load hidden items and favorites
            await Promise.all([
                this.loadHiddenItems(),
                this.loadFavorites()
            ]);

            this.render();
        } catch (err) {
            console.error('Error loading channels:', err);
            this.container.innerHTML = `<div class="empty-state"><p>Error loading channels</p><p class="hint">${err.message}</p></div>`;
        } finally {
            this.isLoading = false;
        }
    }

    /**
     * Load channels from all enabled sources
     */
    async loadAllChannels() {
        this.channels = [];
        this.groups = [];

        try {
            this.container.innerHTML = '<div class="loading"></div>';

            const xtreamSources = this.sources.filter(s => s.type === 'xtream' && s.enabled);
            const m3uSources = this.sources.filter(s => s.type === 'm3u' && s.enabled);
            console.log('[ChannelList] loadAllChannels: xtream=', xtreamSources.length, 'm3u=', m3uSources.length);

            for (const source of xtreamSources) {
                await this.loadXtreamChannels(source.id, true);
            }

            for (const source of m3uSources) {
                await this.loadM3uChannels(source.id, true);
            }

            await Promise.all([
                this.loadHiddenItems(),
                this.loadFavorites()
            ]);
            this.render();
        } catch (err) {
            console.error('Error loading all channels:', err);
        }
    }

    /**
     * Load Xtream channels
     */
    async loadXtreamChannels(sourceId, append = false) {
        if (!append) {
            this.channels = [];
            this.groups = [];
        }

        const categories = await API.proxy.xtream.liveCategories(sourceId);
        const streams = await API.proxy.xtream.liveStreams(sourceId);

        // Map categories to groups
        const categoryGroups = categories.map(cat => ({
            id: `xtream_${sourceId}_${cat.category_id}`,
            name: cat.category_name,
            sourceId,
            sourceType: 'xtream'
        }));

        this.groups.push(...categoryGroups);

        // Map streams to channels
        const channelList = streams.map(stream => ({
            id: `xtream_${sourceId}_${stream.stream_id}`,
            streamId: stream.stream_id,
            name: stream.name,
            tvgId: stream.epg_channel_id,
            tvgLogo: stream.stream_icon,
            groupId: `xtream_${sourceId}_${stream.category_id}`,
            groupTitle: categories.find(c => c.category_id === stream.category_id)?.category_name || 'Uncategorized',
            sourceId,
            sourceType: 'xtream'
        }));

        // Deduplicate by name within the same group (Xtream often sends backup streams with same name)
        const seen = new Set();
        const uniqueChannels = [];
        for (const ch of channelList) {
            const key = `${ch.groupTitle}|${ch.name}`;
            if (!seen.has(key)) {
                seen.add(key);
                uniqueChannels.push(ch);
            }
        }

        this.channels.push(...uniqueChannels);
    }

    /**
     * Load M3U channels
     */
    async loadM3uChannels(sourceId, append = false) {
        if (!append) {
            this.channels = [];
            this.groups = [];
        }

        const data = await API.proxy.m3u.get(sourceId);

        // Add groups
        const m3uGroups = data.groups.map(g => ({
            ...g,
            id: `m3u_${sourceId}_${g.id}`,
            sourceId,
            sourceType: 'm3u'
        }));

        this.groups.push(...m3uGroups);

        // Add channels - use the stable id from the server
        const channelList = data.channels.map(ch => ({
            ...ch,
            // Use the stable id provided by the server (from tvgId or hash)
            id: ch.id,
            groupId: `m3u_${sourceId}_group_${data.groups.findIndex(g => g.name === ch.groupTitle)}`,
            sourceId,
            sourceType: 'm3u'
        }));

        this.channels.push(...channelList);
    }

    /**
     * Load hidden items
     */
    async loadHiddenItems() {
        try {
            const items = await API.channels.getHidden();
            this.hiddenItems = new Set(items.map(i => `${i.item_type}:${i.source_id}:${i.item_id}`));
        } catch (err) {
            console.error('Error loading hidden items:', err);
        }
    }

    /**
     * Check if item is hidden
     */
    isHidden(type, sourceId, itemId) {
        return this.hiddenItems.has(`${type}:${sourceId}:${itemId}`);
    }

    /**
     * Load favorites
     */
    async loadFavorites() {
        try {
            // Get all favorites (filtered for channels or legacy items without type)
            const allFavs = await API.favorites.getAll();
            const channelFavs = allFavs.filter(f => !f.item_type || f.item_type === 'channel');

            this.visibleFavorites = new Set(
                channelFavs.map(f => `${f.source_id}:${f.item_id || f.channel_id}`)
            );
        } catch (err) {
            console.error('Error loading favorites:', err);
        }
    }

    /**
     * Check if channel is favorite
     */
    isFavorite(sourceId, channelId) {
        return this.visibleFavorites.has(`${sourceId}:${channelId}`);
    }

    /**
     * Toggle favorite status
     */
    async toggleFavorite(sourceId, channelId) {
        const key = `${sourceId}:${channelId}`;
        const wasFavorite = this.visibleFavorites.has(key);

        // Find all buttons for this channel in the DOM (it may appear in multiple groups)
        const btns = document.querySelectorAll(`.channel-item[data-channel-id="${channelId}"][data-source-id="${sourceId}"] .favorite-btn`);

        try {
            // Optimistic update
            if (wasFavorite) {
                this.visibleFavorites.delete(key);
                btns.forEach(btn => {
                    btn.classList.remove('active');
                    btn.innerHTML = '♡';
                    btn.title = 'Add to Favorites';
                });
            } else {
                this.visibleFavorites.add(key);
                btns.forEach(btn => {
                    btn.classList.add('active');
                    btn.innerHTML = '❤️';
                    btn.title = 'Remove from Favorites';
                });
            }

            // Updates Favorites Group DOM
            const channel = this.channels.find(c => c.sourceId == sourceId && c.id == channelId);
            if (channel) {
                this.updateFavoritesGroup(channel, !wasFavorite);
            }
            // Do NOT call this.render() - it causes lag

            // Perform API call
            if (wasFavorite) {
                await API.favorites.remove(sourceId, channelId, 'channel');
            } else {
                await API.favorites.add(sourceId, channelId, 'channel');
            }

            // Sync to EPG Guide
            if (window.app?.epgGuide) {
                window.app.epgGuide.syncFavorite(sourceId, channelId, !wasFavorite);
            }
        } catch (err) {
            console.error('Error toggling favorite:', err);
            // Revert on error
            if (wasFavorite) {
                this.visibleFavorites.add(key);
                btns.forEach(btn => {
                    btn.classList.add('active');
                    btn.innerHTML = '❤️';
                });
                // Revert group update
                const channel = this.channels.find(c => c.sourceId == sourceId && c.id == channelId);
                if (channel) this.updateFavoritesGroup(channel, true);
            } else {
                this.visibleFavorites.delete(key);
                btns.forEach(btn => {
                    btn.classList.remove('active');
                    btn.innerHTML = '♡';
                });
                // Revert group update
                const channel = this.channels.find(c => c.sourceId == sourceId && c.id == channelId);
                if (channel) this.updateFavoritesGroup(channel, false);
            }
        }
    }

    /**
     * Update Favorites group in DOM and data
     */
    updateFavoritesGroup(channel, isAdded) {
        // 1. Update Data
        if (!this.groupedChannels['Favorites']) {
            this.groupedChannels['Favorites'] = [];
        }

        const favArray = this.groupedChannels['Favorites'];
        const existingIdx = favArray.findIndex(c => c.id === channel.id && c.sourceId === channel.sourceId);

        if (isAdded) {
            if (existingIdx === -1) favArray.push(channel);
        } else {
            if (existingIdx !== -1) favArray.splice(existingIdx, 1);
        }

        // 2. Update DOM
        const groupHeader = this.listContainer.querySelector('.group-header[data-group="Favorites"]');

        if (!groupHeader) {
            // If group doesn't exist and we're adding, we ideally should create it
            // For now, simpler to just return. User will see it on next refresh.
            // Or we could force a re-render if it's the first favorite? 
            if (isAdded && favArray.length === 1) {
                this.render(); // This is the one case where full render is worth it
            }
            return;
        }

        const groupChannels = groupHeader.nextElementSibling; // .group-channels
        const countSpan = groupHeader.querySelector('.group-count');

        if (isAdded) {
            // Check if already in DOM (to avoid dupes)
            const existingEl = groupChannels.querySelector(`.channel-item[data-channel-id="${channel.id}"][data-source-id="${channel.sourceId}"]`);
            if (!existingEl) {
                const newEl = this.createChannelElement(channel);
                groupChannels.appendChild(newEl);
            }
        } else {
            const existingEl = groupChannels.querySelector(`.channel-item[data-channel-id="${channel.id}"][data-source-id="${channel.sourceId}"]`);
            if (existingEl) {
                existingEl.remove();
            }
        }

        // Update count
        if (countSpan) countSpan.textContent = favArray.length;

        // Hide/Show group if empty?
        if (favArray.length === 0) {
            groupHeader.classList.add('hidden'); // Or remove
            groupHeader.style.display = 'none';
        } else {
            groupHeader.classList.remove('hidden');
            groupHeader.style.display = '';
        }
    }

    createChannelElement(channel) {
        const div = document.createElement('div');
        const isActive = this.currentChannel?.id === channel.id;
        // In Favorites group, it IS a favorite
        const isFavorite = true;

        div.className = `channel-item ${isActive ? 'active' : ''}`;
        div.dataset.channelId = channel.id;
        div.dataset.sourceId = channel.sourceId;
        div.dataset.sourceType = channel.sourceType;
        div.dataset.streamId = channel.streamId || '';
        div.dataset.url = channel.url || '';

        div.innerHTML = `
            <img class="channel-logo" src="${channel.tvgLogo || '/img/placeholder.png'}" 
                 alt="" onerror="this.src='/img/placeholder.png'">
            <div class="channel-info">
              <div class="channel-name">${this.escapeHtml(channel.name)}</div>
              <div class="channel-program">${this.getProgramInfo(channel) || ''}</div>
            </div>
            <button class="favorite-btn active" title="Remove from Favorites">
              ❤️
            </button>
        `;

        // Attach listeners
        div.addEventListener('click', (e) => {
            if (e.target.closest('.favorite-btn')) return;
            this.selectChannel(div.dataset);
        });
        div.addEventListener('contextmenu', (e) => this.showContextMenu(e, 'channel', div.dataset));

        const favBtn = div.querySelector('.favorite-btn');
        if (favBtn) {
            favBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.toggleFavorite(parseInt(div.dataset.sourceId), div.dataset.channelId);
            });
        }

        return div;
    }

    /**
     * Select and play a channel
     */
    async selectChannel(dataset) {
        const channel = this.channels.find(c => c.id === dataset.channelId);
        if (!channel) return;

        this.currentChannel = channel;

        // Update active state in DOM without full re-render
        this.container.querySelectorAll('.channel-item.active').forEach(el => {
            el.classList.remove('active');
        });
        const activeItem = this.container.querySelector(`[data-channel-id="${channel.id}"]`);
        if (activeItem) {
            activeItem.classList.add('active');
        }

        // Get stream URL
        let streamUrl;
        if (channel.sourceType === 'xtream') {
            const result = await API.proxy.xtream.getStreamUrl(channel.sourceId, channel.streamId, 'live');
            streamUrl = result.url;
        } else {
            streamUrl = channel.url;
        }

        // Play channel
        if (window.app?.player) {
            window.app.player.play(channel, streamUrl);
        }
    }

    /**
     * Show context menu
     */
    showContextMenu(e, type, data) {
        e.preventDefault();
        this.contextMenu.dataset.type = type;
        this.contextMenu.dataset.sourceId = data.sourceId;
        this.contextMenu.dataset.itemId = type === 'group' ? data.group : data.channelId;

        this.contextMenu.style.left = `${e.clientX}px`;
        this.contextMenu.style.top = `${e.clientY}px`;
        this.contextMenu.classList.add('active');
    }

    /**
     * Hide context menu
     */
    hideContextMenu() {
        this.contextMenu.classList.remove('active');
    }

    /**
     * Handle context menu action
     */
    async handleContextAction(e) {
        const action = e.target.dataset.action;
        const { type, sourceId, itemId } = this.contextMenu.dataset;

        switch (action) {
            case 'play':
                if (type === 'channel') {
                    const channel = this.channels.find(c => c.id === itemId);
                    if (channel) {
                        await this.selectChannel({ channelId: channel.id });
                    }
                }
                break;
            case 'hide':
                await API.channels.hide(parseInt(sourceId), type, itemId);
                this.hiddenItems.add(`${type}:${sourceId}:${itemId}`);
                this.render();
                break;
            case 'epg':
                // Show EPG info modal
                this.showEpgInfo(itemId);
                break;
        }

        this.hideContextMenu();
    }

    /**
     * Sync favorite status from external source (e.g. EPG) without API call
     */
    syncFavorite(sourceId, channelId, isFavorite) {
        const key = `${sourceId}:${channelId}`;
        const currentlyFav = this.visibleFavorites.has(key);

        if (currentlyFav === isFavorite) return; // No change needed

        // Update State
        if (isFavorite) {
            this.visibleFavorites.add(key);
        } else {
            this.visibleFavorites.delete(key);
        }

        // Update DOM (All instances)
        const btns = document.querySelectorAll(`.channel-item[data-channel-id="${channelId}"][data-source-id="${sourceId}"] .favorite-btn`);

        btns.forEach(btn => {
            if (isFavorite) {
                btn.classList.add('active');
                btn.innerHTML = '❤️';
                btn.title = 'Remove from Favorites';
            } else {
                btn.classList.remove('active');
                btn.innerHTML = '♡';
                btn.title = 'Add to Favorites';
            }
        });

        // Update Favorites Group
        const channel = this.channels.find(c => c.sourceId == sourceId && c.id == channelId);
        if (channel) {
            this.updateFavoritesGroup(channel, isFavorite);
        }
    }

    /**
     * Select next channel in the current list
     */
    selectNextChannel() {
        if (!this.currentChannel || !this.filteredChannels || this.filteredChannels.length === 0) return;

        const currentIndex = this.filteredChannels.findIndex(c =>
            c.id === this.currentChannel.id && c.sourceId === this.currentChannel.sourceId
        );

        if (currentIndex === -1) return;

        const nextIndex = (currentIndex + 1) % this.filteredChannels.length;
        const nextChannel = this.filteredChannels[nextIndex];

        this.selectChannel({
            channelId: nextChannel.id,
            sourceId: nextChannel.sourceId,
            sourceType: nextChannel.sourceType,
            streamId: nextChannel.streamId,
            url: nextChannel.url
        });
    }

    /**
     * Select previous channel in the current list
     */
    selectPrevChannel() {
        if (!this.currentChannel || !this.filteredChannels || this.filteredChannels.length === 0) return;

        const currentIndex = this.filteredChannels.findIndex(c =>
            c.id === this.currentChannel.id && c.sourceId === this.currentChannel.sourceId
        );

        if (currentIndex === -1) return;

        const prevIndex = (currentIndex - 1 + this.filteredChannels.length) % this.filteredChannels.length;
        const prevChannel = this.filteredChannels[prevIndex];

        this.selectChannel({
            channelId: prevChannel.id,
            sourceId: prevChannel.sourceId,
            sourceType: prevChannel.sourceType,
            streamId: prevChannel.streamId,
            url: prevChannel.url
        });
    }

    /**
     * Show EPG info for channel
     */
    async showEpgInfo(channelId) {
        const channel = this.channels.find(c => c.id === channelId);
        if (!channel) return;

        // This would show a modal with EPG info
        console.log('Show EPG for:', channel);
    }

    /**
     * Get list of visible (non-hidden) channels in display order
     */
    getVisibleChannels() {
        const showHidden = this.showHiddenCheckbox.checked;
        return this.channels.filter(ch => {
            if (showHidden) return true;
            const channelHidden = this.isHidden('channel', ch.sourceId, ch.id);
            const groupHidden = this.isHidden('group', ch.sourceId, ch.groupTitle);
            return !channelHidden && !groupHidden;
        });
    }
}

// Export
window.ChannelList = ChannelList;
