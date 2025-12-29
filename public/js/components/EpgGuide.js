/**
 * EPG Guide Component
 * Cable TV-style program guide grid
 */

class EpgGuide {
    constructor() {
        this.container = document.getElementById('epg-grid');
        this.dateDisplay = document.getElementById('guide-date');
        this.prevBtn = document.getElementById('guide-prev');
        this.nextBtn = document.getElementById('guide-next');
        this.nextBtn = document.getElementById('guide-next');
        this.groupSelect = document.getElementById('epg-group-select');
        this.searchInput = document.getElementById('epg-search');

        this.channels = [];
        this.programmes = [];
        this.currentDate = new Date();
        this.timeOffset = 0; // Hours offset from now
        this.pixelsPerMinute = 3.5; // Width scaling
        this.favorites = new Set(); // Set<"sourceId:channelId">
        this.selectedGroup = 'Favorites'; // Default to Favorites

        // Lazy loading properties
        this.filteredChannels = [];
        this.currentBatch = 0;
        this.batchSize = 20; // Channels per batch
        this.startTime = null;
        this.endTime = null;
        this.epgContainer = null;
        this.epgLoader = null;
        this.epgObserver = null;

        this.init();
    }

    init() {
        this.prevBtn.addEventListener('click', () => this.navigate(-2));
        this.nextBtn.addEventListener('click', () => this.navigate(2));

        // Group filter change
        this.groupSelect?.addEventListener('change', () => {
            this.selectedGroup = this.groupSelect.value;
            this.render();
        });

        // Search input
        if (this.searchInput) {
            this.searchInput.addEventListener('input', this.debounce(() => {
                this.render();
            }, 300));
        }

        // Update current time indicator every minute
        setInterval(() => this.updateNowIndicator(), 60000);

        this.initResizer();
    }

    /**
     * Initialize sidebar resizer
     */
    initResizer() {
        let isResizing = false;
        let startX, startWidth;

        document.addEventListener('mousedown', (e) => {
            if (e.target.classList.contains('resize-handle')) {
                isResizing = true;
                startX = e.clientX;
                const sidebar = document.querySelector('.epg-channel-info');
                startWidth = sidebar.getBoundingClientRect().width;
                e.target.classList.add('active');
                document.body.style.cursor = 'col-resize';
                e.preventDefault(); // Prevent text selection
            }
        });

        document.addEventListener('mousemove', (e) => {
            if (!isResizing) return;

            const diff = e.clientX - startX;
            const newWidth = Math.max(150, Math.min(500, startWidth + diff)); // Min 150px, Max 500px

            document.documentElement.style.setProperty('--epg-sidebar-width', `${newWidth}px`);
            this.updateNowIndicator(); // Update line position
        });

        document.addEventListener('mouseup', () => {
            if (isResizing) {
                isResizing = false;
                document.querySelectorAll('.resize-handle').forEach(h => h.classList.remove('active'));
                document.body.style.cursor = '';
            }
        });
    }

    /**
     * Navigate time
     */
    navigate(hours) {
        this.timeOffset += hours;
        this.render();
    }

    /**
     * Get EPG refresh interval from settings (in hours)
     */
    getRefreshInterval() {
        const saved = localStorage.getItem('nodecast_tv_epg_refresh_interval');
        return saved ? parseInt(saved) : 24; // Default 24 hours
    }

    /**
     * Load EPG data (server-side caching)
     */
    async loadEpg(forceRefresh = false) {
        try {
            this.container.innerHTML = '<div class="loading"></div>';
            await this.fetchEpgData(forceRefresh);
            this.render();
        } catch (err) {
            console.error('Error loading EPG:', err);
            this.container.innerHTML = `
        <div class="empty-state">
          <p>Error loading EPG</p>
          <p class="hint">${err.message}</p>
        </div>
      `;
        }
    }

    /**
     * Fetch EPG data from sources
     */
    async fetchEpgData(forceRefresh = false) {
        // Get ALL sources and filter for EPG-capable types
        const allSources = await API.sources.getAll();
        const sources = allSources.filter(s => (s.type === 'epg' || s.type === 'xtream') && s.enabled);

        if (sources.length === 0) {
            throw new Error('No EPG sources or Xtream accounts configured');
        }

        // Build query params for server-side caching
        const maxAge = this.getRefreshInterval();
        const queryParams = forceRefresh ? '?refresh=1' : `?maxAge=${maxAge}`;

        // Load EPG from ALL sources in parallel
        const fetchPromises = sources.map(async (source) => {
            try {
                const response = await fetch(`/api/proxy/epg/${source.id}${queryParams}`);
                if (!response.ok) throw new Error(`Status ${response.status}`);
                return await response.json();
            } catch (e) {
                console.warn(`Failed to load EPG for source ${source.name}:`, e);
                return null;
            }
        });

        const results = await Promise.all(fetchPromises);

        // Merge results
        this.channels = [];
        this.programmes = [];

        let hasData = false;
        results.forEach(data => {
            if (data) {
                if (data.channels && data.channels.length > 0) {
                    this.channels = this.channels.concat(data.channels);
                }
                if (data.programmes && data.programmes.length > 0) {
                    this.programmes = this.programmes.concat(data.programmes);
                }
                if (data.channels || data.programmes) {
                    hasData = true;
                }
            }
        });

        if (!hasData) {
            throw new Error('Failed to load EPG data from any source');
        }

        // Build secondary indexes for faster lookup
        this.channelMap = new Map();
        // Index by ID
        this.channels.forEach(ch => {
            this.channelMap.set(ch.id, ch);
            // Also index by name (normalized) for fallback matching
            if (ch.name) {
                this.channelMap.set(ch.name.toLowerCase(), ch);
            }
        });

        // Load favorites
        const favs = await API.favorites.getAll();
        this.favorites = new Set(favs.map(f => `${f.source_id}:${f.item_id}`));
    }

    /**
     * Get current program for a channel
     * @param {string} tvgId - The EPG channel ID (tvg-id)
     * @param {string} channelName - The channel name (for fallback)
     * @returns {object|null} Program object with title, start, stop
     */
    getCurrentProgram(tvgId, channelName) {
        if (!this.programmes || this.programmes.length === 0) return null;

        // Find EPG channel using fast map lookup
        let epgChannel = null;
        if (tvgId && this.channelMap && this.channelMap.has(tvgId)) {
            epgChannel = this.channelMap.get(tvgId);
        } else if (channelName && this.channelMap) {
            epgChannel = this.channelMap.get(channelName.toLowerCase());
        } else {
            // Fallback to slow search if map fails or not built yet
            epgChannel = this.channels.find(epg =>
                (tvgId && epg.id === tvgId) || epg.name === channelName
            );
        }

        if (!epgChannel) return null;

        const now = new Date();
        const nowTime = now.getTime();

        // Filter programs for this channel
        const current = this.programmes.find(p => {
            if (p.channelId !== epgChannel.id) return false;
            const start = new Date(p.start).getTime();
            const stop = new Date(p.stop).getTime();
            return nowTime >= start && nowTime < stop;
        });

        return current ? {
            title: current.title,
            start: current.start,
            stop: current.stop,
            desc: current.desc
        } : null;
    }

    /**
     * Update filtered channels based on search or group
     */
    updateFilteredChannels() {
        const searchTerm = this.searchInput ? this.searchInput.value.toLowerCase().trim() : '';

        // SEARCH MODE: Filter all channels by name
        if (searchTerm) {
            this.filteredChannels = this.allMatchedChannels.filter(ch => {
                const name = (ch.sourceChannel?.name || '').toLowerCase();
                return name.includes(searchTerm);
            });
            return;
        }

        // GROUP MODE (Default)
        if (this.selectedGroup === 'Favorites') {
            this.filteredChannels = this.allMatchedChannels.filter(m =>
                this.favorites.has(`${m.sourceChannel.sourceId}:${m.sourceChannel.id}`)
            );
            return;
        }

        if (!this.selectedGroup || this.selectedGroup === 'All') {
            this.filteredChannels = [...this.allMatchedChannels];
        } else {
            this.filteredChannels = this.allMatchedChannels.filter(m =>
                (m.sourceChannel.groupTitle || 'Uncategorized') === this.selectedGroup
            );
        }
    }

    /**
     * Render the EPG grid
     */
    render() {
        // Get channel list instance
        const channelList = window.app?.channelList;
        if (!channelList) return;

        // Get channels and filter out hidden ones (always enforce hidden in EPG)
        const playableChannels = (channelList.channels || []).filter(ch => {
            // Use streamId (raw ID) for hidden check since that's what SourceManager stores
            const rawChannelId = ch.streamId || ch.id;
            const isChannelHidden = channelList.isHidden('channel', ch.sourceId, rawChannelId);
            const isGroupHidden = channelList.isHidden('group', ch.sourceId, ch.groupTitle);
            return !isChannelHidden && !isGroupHidden;
        });



        if (playableChannels.length === 0) {
            this.container.innerHTML = `
                <div class="empty-state">
                    <p>No visible channels available</p>
                    <p class="hint">Check your content settings or add a source</p>
                </div>
            `;
            return;
        }

        // Match ALL playable channels with optional EPG data
        const allChannels = playableChannels.map(sourceChannel => {
            // Try to find matching EPG channel by tvgId or name
            const epgChannel = this.channels.find(epg =>
                epg.id === sourceChannel.tvgId || epg.name === sourceChannel.name
            );
            return { epgChannel, sourceChannel };
        });

        // Collect unique groups from ALL playable channels
        const groups = [...new Set(allChannels.map(m => m.sourceChannel.groupTitle || 'Uncategorized'))].sort();

        // Add Favorites at the top if there are any
        const hasFavorites = this.favorites.size > 0;

        // Only rebuild dropdown if groups have changed (performance optimization)
        const groupsKey = groups.join('|') + (hasFavorites ? '|FAV' : '');
        if (this.groupSelect && this._lastGroupsKey !== groupsKey) {
            this._lastGroupsKey = groupsKey;
            const currentValue = this.selectedGroup;
            let optionsHtml = '';

            if (hasFavorites) {
                optionsHtml += `<option value="Favorites" ${currentValue === 'Favorites' ? 'selected' : ''}>Favorites</option>`;
            }

            optionsHtml += `<option value="" ${currentValue === '' ? 'selected' : ''}>All Groups</option>`;
            optionsHtml += groups.map(g => `<option value="${g}" ${g === currentValue ? 'selected' : ''}>${g}</option>`).join('');

            this.groupSelect.innerHTML = optionsHtml;
        } else if (this.groupSelect) {
            // Just update the selected value without rebuilding
            this.groupSelect.value = this.selectedGroup;
        }

        // Handle case where we defaulted to Favorites but user has none
        if (this.selectedGroup === 'Favorites' && !hasFavorites) {
            this.selectedGroup = ''; // Fallback to 'All Groups'
            if (this.groupSelect) this.groupSelect.value = '';
        }

        // Store all channels (matched with EPG data) for filtering
        this.allMatchedChannels = allChannels;
        this.updateFilteredChannels();

        // Calculate time range and store for batch rendering
        this.startTime = new Date();
        this.startTime.setHours(this.startTime.getHours() + this.timeOffset);
        this.startTime.setMinutes(0, 0, 0);

        this.endTime = new Date(this.startTime);
        this.endTime.setHours(this.endTime.getHours() + 24); // Show 24 hours of programming

        // Update date display
        this.updateDateDisplay(this.startTime);

        // Generate time slots
        const timeSlots = this.generateTimeSlots(this.startTime, this.endTime);

        // Build initial HTML structure
        this.container.innerHTML = `
      <div class="epg-container" style="position: relative;">
        <div class="epg-time-header">
          ${timeSlots.map(slot => `
            <div class="epg-time-slot" style="width: ${30 * this.pixelsPerMinute}px;">
              ${slot.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </div>
          `).join('')}
        </div>
        <div class="epg-channel-rows"></div>
        <div class="epg-loader" style="height: 50px; display: flex; align-items: center; justify-content: center;">
          <div class="loading-spinner"></div>
        </div>
      </div>
    `;

        // Get references for batch rendering
        this.epgContainer = this.container.querySelector('.epg-channel-rows');
        this.epgLoader = this.container.querySelector('.epg-loader');

        // Reset batch state
        this.currentBatch = 0;

        // Set up IntersectionObserver for lazy loading
        if (this.epgObserver) {
            this.epgObserver.disconnect();
        }
        this.epgObserver = new IntersectionObserver((entries) => {
            if (entries[0].isIntersecting) {
                this.renderNextEpgBatch();
            }
        }, { rootMargin: '200px' });

        // Render initial batches (render enough to fill viewport)
        for (let i = 0; i < 3; i++) {
            this.renderNextEpgBatch();
        }

        // Start observing loader
        this.epgObserver.observe(this.epgLoader);

        // Add now indicator
        this.updateNowIndicator();
    }

    /**
     * Render next batch of EPG channel rows
     */
    renderNextEpgBatch() {
        const start = this.currentBatch * this.batchSize;
        const end = start + this.batchSize;
        const batch = this.filteredChannels.slice(start, end);

        if (batch.length === 0) {
            this.epgLoader.style.display = 'none';
            return;
        }

        let html = '';
        for (const { epgChannel, sourceChannel } of batch) {
            const isFavorite = this.favorites.has(`${sourceChannel.sourceId}:${sourceChannel.id}`);

            // Get programs if EPG data exists
            let channelProgrammes = [];
            if (epgChannel) {
                channelProgrammes = this.programmes
                    .filter(p => p.channelId === epgChannel.id)
                    .filter(p => {
                        const start = new Date(p.start);
                        const stop = new Date(p.stop);
                        return start < this.endTime && stop > this.startTime;
                    })
                    .sort((a, b) => new Date(a.start) - new Date(b.start));
            }

            // Fallback values if EPG channel is missing
            const logo = sourceChannel.tvgLogo || (epgChannel && epgChannel.icon) || '/img/placeholder.png';
            const name = sourceChannel.name || (epgChannel && epgChannel.name);

            html += `
        <div class="epg-channel-row" 
             data-channel-id="${sourceChannel.id}" 
             data-source-id="${sourceChannel.sourceId}">
          <div class="epg-channel-info">
            <button class="favorite-btn ${isFavorite ? 'active' : ''}" title="${isFavorite ? 'Remove from Favorites' : 'Add to Favorites'}">
              ${isFavorite ? '❤️' : '♡'}
            </button>
            <img class="epg-channel-logo" src="${logo}" 
                 alt="" onerror="this.onerror=null;this.src='/img/placeholder.png'">
            <span class="epg-channel-name">${name}</span>
            <div class="resize-handle"></div>
          </div>
          <div class="epg-programs">
            ${this.renderProgrammes(channelProgrammes, this.startTime, this.endTime)}
          </div>
        </div>
      `;
        }

        // Append to container
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = html;
        while (tempDiv.firstElementChild) {
            const row = tempDiv.firstElementChild;
            this.attachRowListeners(row);
            this.epgContainer.appendChild(row);
        }

        this.currentBatch++;

        // Hide loader if no more batches
        if (end >= this.filteredChannels.length) {
            this.epgLoader.style.display = 'none';
        }
    }

    /**
     * Attach event listeners to an EPG row
     */
    attachRowListeners(row) {
        // Program click handlers
        row.querySelectorAll('.epg-program').forEach(prog => {
            prog.addEventListener('click', () => this.showProgramDetails(prog.dataset));
        });

        const info = row.querySelector('.epg-channel-info');
        if (info) {
            // Name/Logo click plays channel
            info.querySelector('.epg-channel-name')?.addEventListener('click', (e) => {
                e.stopPropagation();
                this.playChannel(info.querySelector('.epg-channel-name').textContent);
            });
            info.querySelector('.epg-channel-logo')?.addEventListener('click', (e) => {
                e.stopPropagation();
                this.playChannel(info.querySelector('.epg-channel-name').textContent);
            });

            // Favorite click
            const favBtn = info.querySelector('.favorite-btn');
            if (favBtn) {
                favBtn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    const sourceId = parseInt(row.dataset.sourceId);
                    const channelId = row.dataset.channelId;
                    await this.toggleFavorite(sourceId, channelId);
                });
            }
        }
    }

    /**
     * Toggle favorite
     */
    async toggleFavorite(sourceId, channelId) {
        const key = `${sourceId}:${channelId}`;
        const wasFavorite = this.favorites.has(key);
        const isNowFavorite = !wasFavorite;

        // 1. Optimistic Update (EPG)
        if (isNowFavorite) {
            this.favorites.add(key);
        } else {
            this.favorites.delete(key);
        }

        // Update DOM (All matching buttons in EPG)
        const rows = this.container.querySelectorAll(`.epg-channel-row[data-channel-id="${channelId}"][data-source-id="${sourceId}"]`);
        rows.forEach(row => {
            const btn = row.querySelector('.favorite-btn');
            if (btn) {
                if (isNowFavorite) {
                    btn.classList.add('active');
                    btn.innerHTML = '❤️';
                    btn.title = 'Remove from Favorites';
                } else {
                    btn.classList.remove('active');
                    btn.innerHTML = '♡';
                    btn.title = 'Add to Favorites';
                }
            }
        });

        // 2. Sync Channel List State (Optimistic)
        if (window.app?.channelList) {
            window.app.channelList.syncFavorite(sourceId, channelId, isNowFavorite);
        }

        try {
            // 3. API Call
            if (wasFavorite) {
                await API.favorites.remove(sourceId, channelId, 'channel');
            } else {
                await API.favorites.add(sourceId, channelId, 'channel');
            }

            // 4. Re-render if viewing Favorites group (so new favorites appear immediately)
            if (this.selectedGroup === 'Favorites') {
                this.render();
            }
        } catch (err) {
            console.error('Error toggling favorite in EPG:', err);

            // Revert EPG
            if (wasFavorite) {
                this.favorites.add(key);
            } else {
                this.favorites.delete(key);
            }

            rows.forEach(row => {
                const btn = row.querySelector('.favorite-btn');
                if (btn) {
                    if (wasFavorite) {
                        btn.classList.add('active');
                        btn.innerHTML = '❤️';
                        btn.title = 'Remove from Favorites';
                    } else {
                        btn.classList.remove('active');
                        btn.innerHTML = '♡';
                        btn.title = 'Add to Favorites';
                    }
                }
            });

            // Revert Channel List
            if (window.app?.channelList) {
                window.app.channelList.syncFavorite(sourceId, channelId, wasFavorite);
            }
        }
    }

    /**
     * Sync favorite status from external source (e.g. ChannelList) without API call
     */
    syncFavorite(sourceId, channelId, isFavorite) {
        // Ensure consistent string format for key
        const key = `${String(sourceId)}:${String(channelId)}`;
        const currentlyFav = this.favorites.has(key);

        if (currentlyFav === isFavorite) return; // No change needed

        // Update State
        if (isFavorite) {
            this.favorites.add(key);
        } else {
            this.favorites.delete(key);
        }

        // Update DOM (All instances in EPG)
        const rows = this.container.querySelectorAll(`.epg-channel-row[data-channel-id="${channelId}"][data-source-id="${sourceId}"]`);
        rows.forEach(row => {
            const btn = row.querySelector('.favorite-btn');
            if (btn) {
                if (isFavorite) {
                    btn.classList.add('active');
                    btn.innerHTML = '❤️';
                    btn.title = 'Remove from Favorites';
                } else {
                    btn.classList.remove('active');
                    btn.innerHTML = '♡';
                    btn.title = 'Add to Favorites';
                }
            }
        });

        // Note: We don't call render() here - the favorites Set is updated
        // and will be used when the user navigates to Guide or switches groups
    }

    /**
     * Generate time slots
     */
    generateTimeSlots(start, end) {
        const slots = [];
        const current = new Date(start);

        while (current < end) {
            slots.push(new Date(current));
            current.setMinutes(current.getMinutes() + 30);
        }

        return slots;
    }

    /**
     * Render programmes for a channel
     */
    renderProgrammes(programmes, startTime, endTime) {
        if (programmes.length === 0) {
            const width = (endTime - startTime) / 60000 * this.pixelsPerMinute;
            return `<div class="epg-program" style="width: ${width}px;"><span class="epg-program-title">No data</span></div>`;
        }

        const now = new Date();
        let html = '';
        let currentPos = startTime.getTime();

        for (const prog of programmes) {
            const progStart = Math.max(new Date(prog.start).getTime(), startTime.getTime());
            const progEnd = Math.min(new Date(prog.stop).getTime(), endTime.getTime());

            // Fill gap if needed
            if (progStart > currentPos) {
                const gapWidth = (progStart - currentPos) / 60000 * this.pixelsPerMinute;
                html += `<div class="epg-program" style="width: ${gapWidth}px;"></div>`;
            }

            const width = (progEnd - progStart) / 60000 * this.pixelsPerMinute;
            const isCurrent = new Date(prog.start) <= now && new Date(prog.stop) > now;

            html += `
        <div class="epg-program ${isCurrent ? 'current' : ''}" 
             style="width: ${width}px;"
             data-title="${prog.title || ''}"
             data-description="${prog.description || ''}"
             data-start="${prog.start}"
             data-stop="${prog.stop}">
          <div class="epg-program-title">${prog.title || 'Unknown'}</div>
          <div class="epg-program-time">
            ${new Date(prog.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </div>
        </div>
      `;

            currentPos = progEnd;
        }

        return html;
    }

    /**
     * Update date display
     */
    updateDateDisplay(date) {
        const today = new Date();
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);

        if (date.toDateString() === today.toDateString()) {
            this.dateDisplay.textContent = 'Today';
        } else if (date.toDateString() === tomorrow.toDateString()) {
            this.dateDisplay.textContent = 'Tomorrow';
        } else {
            this.dateDisplay.textContent = date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
        }
    }

    /**
     * Debounce utility
     */
    debounce(func, wait) {
        let timeout;
        return function executedFunction(...args) {
            const later = () => {
                clearTimeout(timeout);
                func(...args);
            };
            clearTimeout(timeout);
            timeout = setTimeout(later, wait);
        };
    }

    updateNowIndicator() {
        const now = new Date();
        const container = this.container.querySelector('.epg-container');
        if (!container) return;

        // Remove existing indicator
        const existing = container.querySelector('.epg-now-line');
        if (existing) existing.remove();

        // Calculate position
        const startTime = new Date();
        startTime.setHours(startTime.getHours() + this.timeOffset);
        startTime.setMinutes(0, 0, 0);

        const minutesFromStart = (now - startTime) / 60000;
        if (minutesFromStart < 0 || minutesFromStart > 240) return; // Not in visible range

        // Get current sidebar width
        const sidebarWidth = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--epg-sidebar-width')) || 150;
        const leftPos = sidebarWidth + (minutesFromStart * this.pixelsPerMinute);

        const indicator = document.createElement('div');
        indicator.className = 'epg-now-line';
        indicator.style.left = `${leftPos}px`;
        container.appendChild(indicator);
    }

    /**
     * Show program details modal
     */
    showProgramDetails(data) {
        const modal = document.getElementById('modal');
        const title = document.getElementById('modal-title');
        const body = document.getElementById('modal-body');
        const footer = document.getElementById('modal-footer');

        title.textContent = data.title || 'Program Details';

        const start = new Date(data.start);
        const stop = new Date(data.stop);

        body.innerHTML = `
      <p><strong>Time:</strong> ${start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} - ${stop.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>
      <p><strong>Description:</strong></p>
      <p>${data.description || 'No description available'}</p>
    `;

        footer.innerHTML = '<button class="btn btn-secondary" id="modal-close">Close</button>';

        modal.classList.add('active');
        document.getElementById('modal-close').onclick = () => modal.classList.remove('active');
        modal.querySelector('.modal-close').onclick = () => modal.classList.remove('active');
    }

    /**
     * Play channel from EPG
     */
    async playChannel(channelName) {
        // Find channel in channel list and play
        if (window.app?.channelList) {
            const channel = window.app.channelList.channels.find(c =>
                c.name === channelName || c.tvgName === channelName
            );
            if (channel) {
                await window.app.channelList.selectChannel({ channelId: channel.id });
                // Switch to home page
                document.querySelector('[data-page="home"]').click();
            }
        }
    }
}

// Export
window.EpgGuide = EpgGuide;
