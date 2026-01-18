// ============================================
// GEM BID FILTER - CONTENT SCRIPT
// ============================================

(function() {
  'use strict';

  // Configuration
  const CONFIG = {
    panelId: 'gem-bid-filter-panel',
    statusId: 'gem-bid-filter-status',
    highlightClass: 'gem-bid-highlight-today',
    weekHighlightClass: 'gem-bid-highlight-week',
    hideClass: 'gem-bid-hidden',
    dimClass: 'gem-bid-dimmed',
    originalOrderAttr: 'data-gem-original-order',
    startDateAttr: 'data-gem-start-date-ts'
  };

  // ============================================
  // DATE UTILITIES
  // ============================================

  const DateUtils = {
    // Parse GeM date format: "DD-MM-YYYY H:MM AM/PM" or "DD-MM-YYYY"
    parseGemDate: function(dateString) {
      if (!dateString) return null;

      let cleaned = dateString.trim();
      if (!cleaned) return null;

      // Regex to match the format with time
      const regex = /(\d{2})-(\d{2})-(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i;
      const match = cleaned.match(regex);

      if (!match) {
        // Try without time
        const dateOnlyRegex = /(\d{2})-(\d{2})-(\d{4})/;
        const dateMatch = cleaned.match(dateOnlyRegex);
        if (dateMatch) {
          const day = parseInt(dateMatch[1], 10);
          const month = parseInt(dateMatch[2], 10);
          const year = parseInt(dateMatch[3], 10);
          return new Date(year, month - 1, day);
        }
        return null;
      }

      const day = parseInt(match[1], 10);
      const month = parseInt(match[2], 10);
      const year = parseInt(match[3], 10);
      const hours = parseInt(match[4], 10);
      const minutes = parseInt(match[5], 10);
      const ampm = match[6];

      let hour = hours;
      if (ampm.toUpperCase() === 'PM' && hour !== 12) {
        hour += 12;
      } else if (ampm.toUpperCase() === 'AM' && hour === 12) {
        hour = 0;
      }

      return new Date(year, month - 1, day, hour, minutes);
    },

    isToday: function(date) {
      if (!date) return false;
      const today = this.stripTime(new Date());
      const target = this.stripTime(date);
      return target.getTime() === today.getTime();
    },

    isYesterday: function(date) {
      if (!date) return false;
      const today = this.stripTime(new Date());
      const yesterday = new Date(today);
      yesterday.setDate(today.getDate() - 1);
      const target = this.stripTime(date);
      return target.getTime() === yesterday.getTime();
    },

    isWithinDays: function(date, days) {
      if (!date || !days) return false;
      const today = this.stripTime(new Date());
      const start = new Date(today);
      start.setDate(today.getDate() - (days - 1));
      const target = this.stripTime(date);
      return target >= start && target <= today;
    },

    formatRelative: function(date) {
      if (!date) return '';
      if (this.isToday(date)) return 'Today';
      if (this.isYesterday(date)) return 'Yesterday';

      const today = this.stripTime(new Date());
      const target = this.stripTime(date);
      const diffMs = today - target;
      const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
      if (diffDays > 0) {
        return diffDays + ' days ago';
      }
      return 'Upcoming';
    },

    stripTime: function(date) {
      return new Date(date.getFullYear(), date.getMonth(), date.getDate());
    }
  };

  // ============================================
  // DOM PARSER
  // ============================================

  const DOMParser = {
    // Find all bid cards on the page
    findBidCards: function() {
      const selectors = [
        '.bid-card',
        '.bid-card-list .card',
        '.search-bid-results .card',
        '.card',
        '.search-result',
        '.bid-listing',
        '.list-group-item',
        '.result-item',
        '.search-result-item'
      ];

      const cards = [];

      selectors.forEach((selector) => {
        const nodes = Array.from(document.querySelectorAll(selector));
        nodes.forEach((node) => {
          const candidate = promoteCardElement(node);
          if (candidate && elementLooksLikeCard(candidate)) {
            cards.push(candidate);
          }
        });
      });

      const unique = uniqueElements(cards);
      if (unique.length > 0) {
        return unique;
      }

      // Fallback: scan text nodes for "Start Date" or "Bid No" and walk up to a card-like container
      const labelNodes = findTextNodes(document.body, /(start\s*date|bid\s*no)/i);
      const fallbackCards = new Set();

      labelNodes.forEach((node) => {
        const card = findCardContainerFromNode(node.parentElement);
        if (card) {
          fallbackCards.add(card);
        }
      });

      return Array.from(fallbackCards);
    },

    // Extract data from a single bid card
    parseBidCard: function(cardElement, commonAncestor) {
      if (!cardElement) return null;

      const bidNo = extractLabelValue(cardElement, [
        /bid\s*no\b/i,
        /bid\s*number\b/i
      ]);

      const items = extractLabelValue(cardElement, [
        /items?\b/i,
        /description\b/i
      ]);

      const quantity = extractLabelValue(cardElement, [
        /quantity\b/i
      ]);

      const department = extractLabelValue(cardElement, [
        /department\s*name\s*and\s*address\b/i,
        /department\b/i,
        /ministry\b/i
      ]);

      const startDateText = extractLabelValue(cardElement, [
        /start\s*date\b/i
      ]);

      const endDateText = extractLabelValue(cardElement, [
        /end\s*date\b/i
      ]);

      let startDate = null;
      const cachedTs = cardElement.getAttribute(CONFIG.startDateAttr);
      if (cachedTs && !startDateText) {
        const ts = parseInt(cachedTs, 10);
        if (!isNaN(ts)) {
          startDate = new Date(ts);
        }
      }

      if (!startDate && startDateText) {
        startDate = DateUtils.parseGemDate(startDateText);
        if (startDate) {
          cardElement.setAttribute(CONFIG.startDateAttr, String(startDate.getTime()));
        }
      }

      const endDate = endDateText ? DateUtils.parseGemDate(endDateText) : null;

      const sortElement = this.getSortElement(cardElement, commonAncestor);

      return {
        bidNo: bidNo || '',
        items: items || '',
        quantity: quantity || '',
        department: department || '',
        startDate: startDate,
        startDateRaw: startDateText || '',
        endDate: endDate,
        endDateRaw: endDateText || '',
        element: cardElement,
        sortElement: sortElement
      };
    },

    // Parse all bids on current page
    parseAllBids: function() {
      const cards = this.findBidCards();
      const commonAncestor = this.findCommonAncestor(cards);
      const bids = cards.map((card) => this.parseBidCard(card, commonAncestor)).filter(Boolean);
      const sortElements = bids.map((bid) => bid.sortElement || bid.element).filter(Boolean);
      this.cacheOriginalOrder(sortElements);
      return bids;
    },

    cacheOriginalOrder: function(elements) {
      const items = elements && elements.length ? elements : this.findBidCards();
      items.forEach((item, index) => {
        const target = item && item.element ? item.element : item;
        if (target && !target.hasAttribute(CONFIG.originalOrderAttr)) {
          target.setAttribute(CONFIG.originalOrderAttr, String(index));
        }
      });
    },

    findCommonAncestor: function(elements) {
      if (!elements || elements.length === 0) return null;
      const path = [];
      let node = elements[0];
      while (node) {
        path.push(node);
        node = node.parentElement;
      }

      for (let i = 0; i < path.length; i++) {
        const candidate = path[i];
        const containsAll = elements.every((el) => candidate.contains(el));
        if (containsAll) {
          return candidate;
        }
      }

      return null;
    },

    getSortElement: function(cardElement, commonAncestor) {
      if (!cardElement) return null;
      if (!commonAncestor || !isSafeContainer(commonAncestor)) return cardElement;
      let el = cardElement;
      while (el.parentElement && el.parentElement !== commonAncestor) {
        el = el.parentElement;
      }
      return el;
    },

    findBestContainer: function(items) {
      const elements = (items || []).map((item) => {
        if (!item) return null;
        if (item.sortElement) return item.sortElement;
        if (item.element) return item.element;
        return item;
      }).filter(Boolean);

      if (elements.length === 0) return null;

      const commonAncestor = this.findCommonAncestor(elements);
      if (isSafeContainer(commonAncestor) && elements.every((el) => el.parentElement === commonAncestor)) {
        return commonAncestor;
      }

      const parent = elements[0].parentElement;
      if (parent && elements.every((el) => el.parentElement === parent)) {
        return parent;
      }

      return null;
    }
  };

  // ============================================
  // FILTER ENGINE
  // ============================================

  const FilterEngine = {
    // Sort bids by start date (newest first)
    sortByNewest: function(bids) {
      const withDate = bids.filter((bid) => bid.startDate instanceof Date && !isNaN(bid.startDate));
      const withoutDate = bids.filter((bid) => !(bid.startDate instanceof Date) || isNaN(bid.startDate));

      withDate.sort((a, b) => b.startDate.getTime() - a.startDate.getTime());

      if (withoutDate.length > 0) {
        withoutDate.sort((a, b) => {
          const elementA = a.sortElement || a.element;
          const elementB = b.sortElement || b.element;
          const orderA = elementA ? parseInt(elementA.getAttribute(CONFIG.originalOrderAttr) || '0', 10) : 0;
          const orderB = elementB ? parseInt(elementB.getAttribute(CONFIG.originalOrderAttr) || '0', 10) : 0;
          return orderA - orderB;
        });
      }

      return withDate.concat(withoutDate);
    },

    // Filter to only today's bids
    filterToday: function(bids) {
      return bids.filter((bid) => DateUtils.isToday(bid.startDate));
    },

    // Filter to this week's bids
    filterThisWeek: function(bids) {
      return bids.filter((bid) => DateUtils.isWithinDays(bid.startDate, 7));
    },

    // Filter to custom date range
    filterDateRange: function(bids, fromDate, toDate) {
      const from = fromDate ? DateUtils.stripTime(fromDate) : null;
      const to = toDate ? DateUtils.stripTime(toDate) : null;

      return bids.filter((bid) => {
        if (!bid.startDate) return false;
        const target = DateUtils.stripTime(bid.startDate);
        if (from && target < from) return false;
        if (to && target > to) return false;
        return true;
      });
    }
  };

  // ============================================
  // UI MANAGER
  // ============================================

  const UIManager = {
    createPanel: function() {
      if (document.getElementById(CONFIG.panelId)) return;

      const panel = document.createElement('div');
      panel.id = CONFIG.panelId;
      panel.innerHTML = [
        '<div class="panel-header">',
        '  <h3>GeM Bid Filter</h3>',
        '  <button class="panel-toggle" aria-label="Toggle panel" type="button">-</button>',
        '</div>',
        '<div class="panel-body">',
        '  <div class="section-label">Quick Filters</div>',
        '  <div class="button-grid">',
        '    <button class="filter-btn" data-action="today" type="button">Today\'s Bids</button>',
        '    <button class="filter-btn" data-action="week" type="button">This Week</button>',
        '    <button class="filter-btn" data-action="sort" type="button">Sort by Newest</button>',
        '    <button class="filter-btn reset-btn full-width" data-action="reset" type="button">Reset</button>',
        '  </div>',
        '  <div class="status-bar info" id="' + CONFIG.statusId + '">Ready</div>',
        '</div>'
      ].join('\n');

      document.body.appendChild(panel);

      this.makeDraggable(panel);
      this.bindPanelActions(panel);
    },

    bindPanelActions: function(panel) {
      const toggleButton = panel.querySelector('.panel-toggle');
      if (toggleButton) {
        toggleButton.addEventListener('click', () => {
          panel.classList.toggle('collapsed');
          toggleButton.textContent = panel.classList.contains('collapsed') ? '+' : '-';
        });
      }

      const buttons = panel.querySelectorAll('.filter-btn');
      buttons.forEach((button) => {
        button.addEventListener('click', () => {
          const action = button.getAttribute('data-action');
          if (!action) return;

          if (action === 'today') {
            Controller.showTodaysBids();
          } else if (action === 'week') {
            Controller.showThisWeekBids();
          } else if (action === 'sort') {
            Controller.sortByNewest();
          } else if (action === 'reset') {
            Controller.reset();
          }
        });
      });
    },

    updateStatus: function(message, type) {
      const status = document.getElementById(CONFIG.statusId);
      if (!status) return;

      status.textContent = message;
      status.classList.remove('info', 'warning');
      if (type === 'warning') {
        status.classList.add('warning');
      } else {
        status.classList.add('info');
      }
    },

    setActiveButton: function(action) {
      const panel = document.getElementById(CONFIG.panelId);
      if (!panel) return;
      const buttons = panel.querySelectorAll('.filter-btn');
      buttons.forEach((button) => {
        const matches = action && button.getAttribute('data-action') === action;
        button.classList.toggle('active', matches);
      });
    },

    highlightBids: function(bids, highlightClass) {
      const className = highlightClass || CONFIG.highlightClass;
      bids.forEach((bid) => {
        const target = bid.element || bid.sortElement;
        if (!target) return;
        target.classList.add(className);
      });
    },

    hideBids: function(bidsToHide) {
      bidsToHide.forEach((bid) => {
        const target = bid.sortElement || bid.element;
        if (!target) return;
        target.classList.add(CONFIG.hideClass);
      });
    },

    showAllBids: function() {
      const cards = DOMParser.findBidCards();
      const commonAncestor = DOMParser.findCommonAncestor(cards);
      cards.forEach((card) => {
        card.classList.remove(CONFIG.highlightClass, CONFIG.weekHighlightClass, CONFIG.hideClass, CONFIG.dimClass);
        const sortElement = DOMParser.getSortElement(card, commonAncestor);
        if (sortElement && sortElement !== card) {
          sortElement.classList.remove(CONFIG.highlightClass, CONFIG.weekHighlightClass, CONFIG.hideClass, CONFIG.dimClass);
        }
      });
    },

    showHiddenBids: function() {
      const cards = DOMParser.findBidCards();
      const commonAncestor = DOMParser.findCommonAncestor(cards);
      cards.forEach((card) => {
        card.classList.remove(CONFIG.hideClass);
        const sortElement = DOMParser.getSortElement(card, commonAncestor);
        if (sortElement && sortElement !== card) {
          sortElement.classList.remove(CONFIG.hideClass);
        }
      });
    },

    makeDraggable: function(panel) {
      const header = panel.querySelector('.panel-header');
      if (!header) return;

      let startX = 0;
      let startY = 0;
      let startLeft = 0;
      let startTop = 0;
      let dragging = false;

      const onMouseMove = (event) => {
        if (!dragging) return;
        const dx = event.clientX - startX;
        const dy = event.clientY - startY;
        panel.style.left = startLeft + dx + 'px';
        panel.style.top = startTop + dy + 'px';
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
      };

      const onMouseUp = () => {
        dragging = false;
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
      };

      header.addEventListener('mousedown', (event) => {
        if (event.button !== 0) return;
        dragging = true;
        startX = event.clientX;
        startY = event.clientY;
        startLeft = panel.offsetLeft;
        startTop = panel.offsetTop;
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
      });
    }
  };

  // ============================================
  // MAIN CONTROLLER
  // ============================================

  const Controller = {
    activeFilter: null,
    settings: {
      autoHighlight: true,
      hideOldBids: false
    },

    init: function() {
      // Wait for page to be ready
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => this.setup());
      } else {
        this.setup();
      }
    },

    setup: function() {
      UIManager.createPanel();
      DOMParser.parseAllBids();
      this.loadSettings();
      this.observePageChanges();
      this.registerSettingsListener();
      UIManager.updateStatus('Ready', 'info');
    },

    loadSettings: function() {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.sync) {
        this.applySettings();
        return;
      }

      chrome.storage.sync.get(['autoHighlight', 'hideOldBids'], (result) => {
        this.settings.autoHighlight = result.autoHighlight !== false;
        this.settings.hideOldBids = result.hideOldBids === true;
        this.applySettings();
      });
    },

    registerSettingsListener: function() {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.onChanged) return;
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'sync') return;
        let updated = false;

        if (Object.prototype.hasOwnProperty.call(changes, 'autoHighlight')) {
          this.settings.autoHighlight = changes.autoHighlight.newValue !== false;
          updated = true;
        }

        if (Object.prototype.hasOwnProperty.call(changes, 'hideOldBids')) {
          this.settings.hideOldBids = changes.hideOldBids.newValue === true;
          updated = true;
        }

        if (updated) {
          this.reapplyActiveFilter('settings-change');
        }
      });
    },

    applySettings: function() {
      if (!this.activeFilter && this.settings.autoHighlight) {
        this.showTodaysBids({
          hideOthers: false,
          setActive: false,
          resetView: true,
          statusMessage: 'Auto-highlighted today\'s bids'
        });
      }

      if (this.settings.hideOldBids) {
        this.hideBidsOlderThan(7);
      }
    },

    observePageChanges: function() {
      let refreshTimer = null;

      const observer = new MutationObserver((mutations) => {
        const hasNewNodes = mutations.some((mutation) => mutation.addedNodes && mutation.addedNodes.length > 0);
        if (!hasNewNodes) return;

        if (refreshTimer) return;
        refreshTimer = window.setTimeout(() => {
          refreshTimer = null;
          DOMParser.parseAllBids();
          this.reapplyActiveFilter('mutation');
        }, 300);
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true
      });
    },

    reapplyActiveFilter: function(reason) {
      if (this.activeFilter === 'today') {
        this.showTodaysBids({ setActive: false, resetView: true });
      } else if (this.activeFilter === 'week') {
        this.showThisWeekBids({ setActive: false, resetView: true });
      } else if (this.activeFilter === 'sort') {
        this.sortByNewest({ setActive: false });
      } else {
        if (reason === 'settings-change' && !this.settings.hideOldBids) {
          UIManager.showHiddenBids();
        }
        this.applySettings();
      }

      if (this.settings.hideOldBids) {
        this.hideBidsOlderThan(7);
      }
    },

    showTodaysBids: function(options) {
      const opts = Object.assign({
        hideOthers: false,
        setActive: true,
        resetView: true,
        statusMessage: null
      }, options || {});

      const allBids = DOMParser.parseAllBids();
      const todaysBids = FilterEngine.filterToday(allBids);

      if (opts.resetView) {
        UIManager.showAllBids();
      }

      if (todaysBids.length > 0) {
        UIManager.highlightBids(todaysBids, CONFIG.highlightClass);
        if (opts.hideOthers) {
          const otherBids = allBids.filter((bid) => todaysBids.indexOf(bid) === -1);
          UIManager.hideBids(otherBids);
        }
      }

      const message = opts.statusMessage || ('Found ' + todaysBids.length + ' bids from today');
      UIManager.updateStatus(message, todaysBids.length > 0 ? 'info' : 'warning');

      if (opts.setActive) {
        this.activeFilter = 'today';
        UIManager.setActiveButton('today');
      }

      if (this.settings.hideOldBids) {
        this.hideBidsOlderThan(7);
      }
    },

    showThisWeekBids: function(options) {
      const opts = Object.assign({
        setActive: true,
        resetView: true
      }, options || {});

      const allBids = DOMParser.parseAllBids();
      const weekBids = FilterEngine.filterThisWeek(allBids);

      if (opts.resetView) {
        UIManager.showAllBids();
      }

      if (weekBids.length > 0) {
        UIManager.highlightBids(weekBids, CONFIG.weekHighlightClass);
      }

      UIManager.updateStatus('Found ' + weekBids.length + ' bids from this week', weekBids.length > 0 ? 'info' : 'warning');

      if (opts.setActive) {
        this.activeFilter = 'week';
        UIManager.setActiveButton('week');
      }

      if (this.settings.hideOldBids) {
        this.hideBidsOlderThan(7);
      }
    },

    sortByNewest: function(options) {
      const opts = Object.assign({
        setActive: true
      }, options || {});

      const allBids = DOMParser.parseAllBids();
      const sorted = FilterEngine.sortByNewest(allBids);

      const container = DOMParser.findBestContainer(sorted);
      if (!container) {
        UIManager.updateStatus('Unable to locate bid list to sort', 'warning');
        return;
      }

      const hasDates = sorted.some((bid) => bid.startDate instanceof Date && !isNaN(bid.startDate));
      if (!hasDates) {
        UIManager.updateStatus('No start dates found to sort', 'warning');
        return;
      }

      sorted.forEach((bid) => {
        const target = bid.sortElement || bid.element;
        if (target && target.parentElement === container) {
          container.appendChild(target);
        }
      });

      UIManager.updateStatus('Sorted by newest first', 'info');

      if (opts.setActive) {
        this.activeFilter = 'sort';
        UIManager.setActiveButton('sort');
      }

      if (this.settings.hideOldBids) {
        this.hideBidsOlderThan(7);
      }
    },

    reset: function() {
      UIManager.showAllBids();
      this.restoreOriginalOrder();
      this.activeFilter = null;
      UIManager.setActiveButton(null);
      UIManager.updateStatus('Filters reset', 'info');

      if (this.settings.hideOldBids) {
        this.hideBidsOlderThan(7);
      }
    },

    restoreOriginalOrder: function() {
      const allBids = DOMParser.parseAllBids();
      const elements = allBids.map((bid) => bid.sortElement || bid.element).filter(Boolean);
      if (elements.length === 0) return;

      const withOrder = elements.slice().sort((a, b) => {
        const orderA = parseInt(a.getAttribute(CONFIG.originalOrderAttr) || '0', 10);
        const orderB = parseInt(b.getAttribute(CONFIG.originalOrderAttr) || '0', 10);
        return orderA - orderB;
      });

      const container = DOMParser.findBestContainer(withOrder);
      if (!container) return;

      withOrder.forEach((card) => {
        if (card.parentElement === container) {
          container.appendChild(card);
        }
      });
    },

    hideBidsOlderThan: function(days) {
      const allBids = DOMParser.parseAllBids();
      const toHide = allBids.filter((bid) => {
        if (!bid.startDate) return false;
        return !DateUtils.isWithinDays(bid.startDate, days);
      });

      if (toHide.length > 0) {
        UIManager.hideBids(toHide);
      }
    }
  };

  // ============================================
  // HELPERS
  // ============================================

  function normalizeWhitespace(text) {
    return text.replace(/\s+/g, ' ').trim();
  }

  function uniqueElements(elements) {
    const seen = new Set();
    const result = [];
    elements.forEach((el) => {
      if (!seen.has(el)) {
        seen.add(el);
        result.push(el);
      }
    });
    return result;
  }

  function findTextNodes(root, regex) {
    const nodes = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function(node) {
        if (!node || !node.nodeValue) return NodeFilter.FILTER_SKIP;
        if (regex.test(node.nodeValue)) return NodeFilter.FILTER_ACCEPT;
        return NodeFilter.FILTER_SKIP;
      }
    });

    while (walker.nextNode()) {
      nodes.push(walker.currentNode);
    }

    return nodes;
  }

  function elementLooksLikeCard(element) {
    if (!element || !element.textContent) return false;
    const text = normalizeWhitespace(element.textContent);
    if (!/start\s*date/i.test(text)) return false;
    if (!/bid\s*no/i.test(text)) return false;
    if (countRegexMatches(text, /bid\s*no/ig) > 1) return false;
    return true;
  }

  function extractLabelValue(cardElement, labelRegexes) {
    if (!cardElement) return '';

    const cardText = normalizeWhitespace(cardElement.textContent || '');
    const hasDateLabel = labelRegexes.some((regex) => /date/i.test(regex.source));
    if (hasDateLabel && cardText) {
      for (let i = 0; i < labelRegexes.length; i++) {
        const labelRegex = labelRegexes[i];
        const pattern = new RegExp(
          labelRegex.source +
            '\\s*:?\\s*(\\d{2}-\\d{2}-\\d{4}(?:\\s+\\d{1,2}:\\d{2}\\s*(?:AM|PM))?)',
          'i'
        );
        const match = cardText.match(pattern);
        if (match && match[1]) {
          return normalizeWhitespace(match[1]);
        }
      }
    }

    const labelElements = Array.from(cardElement.querySelectorAll('*'));
    for (let i = 0; i < labelElements.length; i++) {
      const el = labelElements[i];
      const text = normalizeWhitespace(el.textContent || '');
      if (!text) continue;

      for (let j = 0; j < labelRegexes.length; j++) {
        const labelRegex = labelRegexes[j];
        if (!labelRegex.test(text)) continue;

        const inlineRegex = new RegExp(labelRegex.source + '\\s*:?\\s*(.+)', 'i');
        const inlineMatch = text.match(inlineRegex);
        if (inlineMatch && inlineMatch[1]) {
          return normalizeWhitespace(inlineMatch[1]);
        }

        const siblingValue = findValueFromSibling(el, labelRegexes);
        if (siblingValue) {
          return siblingValue;
        }
      }
    }

    const textNodes = collectTextNodes(cardElement);

    for (let i = 0; i < textNodes.length; i++) {
      const entry = textNodes[i];
      const text = entry.text;

      for (let j = 0; j < labelRegexes.length; j++) {
        const labelRegex = labelRegexes[j];
        const inlineRegex = new RegExp(labelRegex.source + '\\s*:?\\s*(.+)', 'i');
        const inlineMatch = text.match(inlineRegex);
        if (inlineMatch && inlineMatch[1]) {
          return normalizeWhitespace(inlineMatch[1]);
        }

        const labelRemoved = normalizeWhitespace(text.replace(labelRegex, ''))
          .replace(/^[:\s-]+/, '')
          .replace(/[:\s-]+$/, '');

        if (!labelRemoved) {
          const parent = entry.node.parentElement;
          if (parent) {
            const siblingValues = collectTextNodes(parent)
              .filter((nodeEntry) => nodeEntry.node !== entry.node)
              .map((nodeEntry) => nodeEntry.text)
              .filter(Boolean);

            if (siblingValues.length === 1) {
              return siblingValues[0];
            }

            if (siblingValues.length > 1) {
              return siblingValues[siblingValues.length - 1];
            }
          }

          for (let k = i + 1; k < textNodes.length; k++) {
            if (textNodes[k].text) {
              return textNodes[k].text;
            }
          }
        }
      }
    }

    return '';
  }

  function collectTextNodes(root) {
    const nodes = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);

    while (walker.nextNode()) {
      const node = walker.currentNode;
      const text = normalizeWhitespace(node.nodeValue || '');
      if (text) {
        nodes.push({ node: node, text: text });
      }
    }

    return nodes;
  }

  function textMatchesAny(text, regexes) {
    return regexes.some((regex) => regex.test(text));
  }

  function findValueFromSibling(labelElement, labelRegexes) {
    if (!labelElement) return '';

    let sibling = labelElement.nextElementSibling;
    while (sibling) {
      const text = normalizeWhitespace(sibling.textContent || '');
      if (text && !textMatchesAny(text, labelRegexes)) {
        return text;
      }
      sibling = sibling.nextElementSibling;
    }

    const parent = labelElement.parentElement;
    if (parent) {
      const children = Array.from(parent.children);
      const index = children.indexOf(labelElement);
      if (index >= 0) {
        for (let i = index + 1; i < children.length; i++) {
          const text = normalizeWhitespace(children[i].textContent || '');
          if (text && !textMatchesAny(text, labelRegexes)) {
            return text;
          }
        }
      }

      sibling = parent.nextElementSibling;
      while (sibling) {
        const text = normalizeWhitespace(sibling.textContent || '');
        if (text && !textMatchesAny(text, labelRegexes)) {
          return text;
        }
        sibling = sibling.nextElementSibling;
      }
    }

    return '';
  }

  function countRegexMatches(text, regex) {
    if (!text) return 0;
    const flags = regex.flags.indexOf('g') === -1 ? regex.flags + 'g' : regex.flags;
    const re = new RegExp(regex.source, flags);
    const matches = text.match(re);
    return matches ? matches.length : 0;
  }

  function promoteCardElement(element) {
    if (!element) return null;
    if (elementLooksLikeCard(element)) return element;

    const selectors = [
      '.bid-card',
      '.card',
      '.list-group-item',
      '.search-result',
      '.bid-listing',
      '.result-item',
      '.search-result-item'
    ];

    for (let i = 0; i < selectors.length; i++) {
      const candidate = element.closest(selectors[i]);
      if (candidate && elementLooksLikeCard(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  function findCardContainerFromNode(element) {
    let el = element;
    while (el && el !== document.body) {
      if (elementLooksLikeCard(el)) {
        return el;
      }
      el = el.parentElement;
    }
    return null;
  }

  function isSafeContainer(container) {
    return container && container !== document.body && container !== document.documentElement;
  }

  // Start the extension
  Controller.init();

})();
