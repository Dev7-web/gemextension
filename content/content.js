// ============================================
// GEM TENDER PUBLISHED DATE SORTER - CONTENT SCRIPT
// ============================================

(function() {
  'use strict';

  const CONFIG = {
    panelId: 'gem-bid-filter-panel',
    statusId: 'gem-bid-filter-status',
    scanStatusId: 'gem-bid-filter-scan-status',
    scanResultsId: 'gem-bid-filter-scan-results',
    highlightClass: 'gem-bid-highlight-today',
    weekHighlightClass: 'gem-bid-highlight-week',
    hideClass: 'gem-bid-hidden',
    dimClass: 'gem-bid-dimmed',
    originalOrderAttr: 'data-gem-original-order',
    listingStartDateAttr: 'data-gem-listing-start-date-ts',
    publicationDateAttr: 'data-gem-publication-date-ts',
    publicationDateRawAttr: 'data-gem-publication-date-raw',
    pdfConcurrency: 4,
    pdfFetchTimeoutMs: 15000,
    pdfParseTimeoutMs: 15000,
    pdfCleanupTimeoutMs: 2000,
    pageFetchTimeoutMs: 15000,
    maxShownResults: 100,
    maxUnavailableShown: 20
  };

  const PDFJS_CONFIG = {
    libraryPath: 'vendor/pdfjs/pdf.min.mjs',
    workerPath: 'vendor/pdfjs/pdf.worker.min.mjs',
    pagesToRead: 2
  };

  const CACHE_CONFIG = {
    storageKey: 'gemBidPublicationDateCacheV1',
    maxEntries: 5000
  };

  // ============================================
  // DATE UTILITIES
  // ============================================

  const DateUtils = {
    parseGemDate: function(dateString) {
      if (!dateString) return null;

      const cleaned = normalizeWhitespace(dateString);
      if (!cleaned) return null;

      const regex = /(\d{1,2})[-/](\d{1,2})[-/](\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?/i;
      const match = cleaned.match(regex);
      if (!match) return null;

      const day = parseInt(match[1], 10);
      const month = parseInt(match[2], 10);
      const year = parseInt(match[3], 10);
      let hour = match[4] ? parseInt(match[4], 10) : 0;
      const minutes = match[5] ? parseInt(match[5], 10) : 0;
      const seconds = match[6] ? parseInt(match[6], 10) : 0;
      const ampm = match[7] || '';

      if (ampm.toUpperCase() === 'PM' && hour !== 12) {
        hour += 12;
      } else if (ampm.toUpperCase() === 'AM' && hour === 12) {
        hour = 0;
      }

      const date = new Date(year, month - 1, day, hour, minutes, seconds);
      if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
        return null;
      }

      return date;
    },

    isValidDate: function(date) {
      return date instanceof Date && !isNaN(date.getTime());
    },

    isToday: function(date) {
      if (!this.isValidDate(date)) return false;
      const today = this.stripTime(new Date());
      const target = this.stripTime(date);
      return target.getTime() === today.getTime();
    },

    isWithinDays: function(date, days) {
      if (!this.isValidDate(date) || !days) return false;
      const today = this.stripTime(new Date());
      const start = new Date(today);
      start.setDate(today.getDate() - (days - 1));
      const target = this.stripTime(date);
      return target >= start && target <= today;
    },

    stripTime: function(date) {
      return new Date(date.getFullYear(), date.getMonth(), date.getDate());
    },

    formatDate: function(date) {
      if (!this.isValidDate(date)) return '';
      const day = String(date.getDate()).padStart(2, '0');
      const month = String(date.getMonth() + 1).padStart(2, '0');
      return day + '-' + month + '-' + date.getFullYear();
    }
  };

  // ============================================
  // DOM PARSER
  // ============================================

  const DOMParser = {
    findBidCards: function(root) {
      const scope = root || document;
      const searchRoot = scope.body || scope;
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
        const nodes = Array.from(searchRoot.querySelectorAll(selector));
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

      const labelNodes = findTextNodes(searchRoot, /(start\s*date|bid\s*no)/i);
      const fallbackCards = new Set();

      labelNodes.forEach((node) => {
        const card = findCardContainerFromNode(node.parentElement, searchRoot);
        if (card) {
          fallbackCards.add(card);
        }
      });

      return Array.from(fallbackCards);
    },

    parseBidCard: function(cardElement, commonAncestor, baseUrl, pageNumber, scanOrder) {
      if (!cardElement) return null;

      const bidNo = extractBidNo(cardElement);
      const items = trimExtractedValue(extractLabelValue(cardElement, [
        /items?\b/i,
        /description\b/i
      ]));
      const quantity = trimExtractedValue(extractLabelValue(cardElement, [
        /quantity\b/i
      ]));
      const department = trimExtractedValue(extractLabelValue(cardElement, [
        /department\s*name\s*and\s*address\b/i,
        /department\b/i,
        /ministry\b/i
      ]));
      const listingStartDateRaw = extractLabelValue(cardElement, [
        /start\s*date\b/i
      ]);
      const listingEndDateRaw = extractLabelValue(cardElement, [
        /end\s*date\b/i
      ]);

      let listingStartDate = null;
      const cachedListingTs = cardElement.getAttribute(CONFIG.listingStartDateAttr);
      if (cachedListingTs && !listingStartDateRaw) {
        const ts = parseInt(cachedListingTs, 10);
        if (!isNaN(ts)) {
          listingStartDate = new Date(ts);
        }
      }

      if (!listingStartDate && listingStartDateRaw) {
        listingStartDate = DateUtils.parseGemDate(listingStartDateRaw);
        if (listingStartDate) {
          cardElement.setAttribute(CONFIG.listingStartDateAttr, String(listingStartDate.getTime()));
        }
      }

      const listingEndDate = listingEndDateRaw ? DateUtils.parseGemDate(listingEndDateRaw) : null;
      const sortElement = this.getSortElement(cardElement, commonAncestor);
      const resolvedBase = baseUrl || window.location.href;
      const bidDocumentUrl = extractBidLink(cardElement, bidNo, resolvedBase);
      const publicationDate = readElementPublicationDate(cardElement);
      const publicationDateRaw = cardElement.getAttribute(CONFIG.publicationDateRawAttr) || '';

      return {
        bidNo: bidNo || '',
        items: items || '',
        quantity: quantity || '',
        department: department || '',
        listingStartDate: listingStartDate,
        listingStartDateRaw: listingStartDateRaw || '',
        listingEndDate: listingEndDate,
        listingEndDateRaw: listingEndDateRaw || '',
        startDate: listingStartDate,
        startDateRaw: listingStartDateRaw || '',
        endDate: listingEndDate,
        endDateRaw: listingEndDateRaw || '',
        publicationDate: publicationDate,
        publicationDateRaw: publicationDateRaw,
        bidDocumentUrl: bidDocumentUrl || '',
        bidLink: bidDocumentUrl || '',
        extractionStatus: publicationDate ? 'cached-element' : 'pending',
        extractionError: '',
        element: cardElement,
        sortElement: sortElement,
        sourceUrl: resolvedBase,
        pageNumber: pageNumber || null,
        sourcePageNumber: pageNumber || null,
        scanOrder: typeof scanOrder === 'number' ? scanOrder : null
      };
    },

    parseAllBids: function(options) {
      const opts = options || {};
      const cards = this.findBidCards();
      const commonAncestor = this.findCommonAncestor(cards);
      const baseUrl = opts.baseUrl || window.location.href;
      const pageNumber = opts.pageNumber || null;
      const bids = cards.map((card, index) => this.parseBidCard(
        card,
        commonAncestor,
        baseUrl,
        pageNumber,
        typeof opts.scanOrderOffset === 'number' ? opts.scanOrderOffset + index : index
      )).filter(Boolean);
      const sortElements = bids.map((bid) => bid.sortElement || bid.element).filter(Boolean);
      this.cacheOriginalOrder(sortElements);
      return bids;
    },

    parseAllBidsFromRoot: function(root, options) {
      if (!root) return [];
      const opts = options || {};
      const cards = this.findBidCards(root);
      const commonAncestor = this.findCommonAncestor(cards);
      const baseUrl = opts.baseUrl || (root.URL || window.location.href);
      const pageNumber = opts.pageNumber || null;
      return cards.map((card, index) => this.parseBidCard(
        card,
        commonAncestor,
        baseUrl,
        pageNumber,
        typeof opts.scanOrderOffset === 'number' ? opts.scanOrderOffset + index : index
      )).filter(Boolean);
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
    sortByPublicationDate: function(bids) {
      return (bids || []).slice().sort((a, b) => {
        const aHasPublication = DateUtils.isValidDate(a.publicationDate);
        const bHasPublication = DateUtils.isValidDate(b.publicationDate);

        if (aHasPublication && bHasPublication) {
          const diff = b.publicationDate.getTime() - a.publicationDate.getTime();
          if (diff !== 0) return diff;
        } else if (aHasPublication !== bHasPublication) {
          return aHasPublication ? -1 : 1;
        }

        const aHasListing = DateUtils.isValidDate(a.listingStartDate);
        const bHasListing = DateUtils.isValidDate(b.listingStartDate);

        if (aHasListing && bHasListing) {
          const listingDiff = b.listingStartDate.getTime() - a.listingStartDate.getTime();
          if (listingDiff !== 0) return listingDiff;
        } else if (aHasListing !== bHasListing) {
          return aHasListing ? -1 : 1;
        }

        return getStableOrder(a) - getStableOrder(b);
      });
    },

    filterPublishedToday: function(bids) {
      return (bids || []).filter((bid) => DateUtils.isToday(bid.publicationDate));
    },

    filterPublishedThisWeek: function(bids) {
      return (bids || []).filter((bid) => DateUtils.isWithinDays(bid.publicationDate, 7));
    },

    getDateUnavailable: function(bids) {
      return (bids || []).filter((bid) => {
        if (DateUtils.isValidDate(bid.publicationDate)) return false;
        return bid.extractionStatus === 'unavailable' || bid.extractionStatus === 'no-document-url';
      });
    },

    getRenderableResults: function(bids) {
      return (bids || []).filter((bid) => {
        return DateUtils.isValidDate(bid.publicationDate) ||
          bid.extractionStatus === 'unavailable' ||
          bid.extractionStatus === 'no-document-url';
      });
    }
  };

  // ============================================
  // CACHE MANAGER
  // ============================================

  const CacheManager = {
    loaded: false,
    dirty: false,
    dirtyCount: 0,
    cache: {
      version: 1,
      entries: {}
    },

    isAvailable: function() {
      return typeof chrome !== 'undefined' &&
        chrome.storage &&
        chrome.storage.local;
    },

    load: async function() {
      if (this.loaded) return;
      this.loaded = true;

      if (!this.isAvailable()) return;

      try {
        const result = await chromeStorageGet('local', [CACHE_CONFIG.storageKey]);
        const stored = result && result[CACHE_CONFIG.storageKey];
        if (stored && stored.entries && typeof stored.entries === 'object') {
          this.cache = stored;
        }
      } catch (error) {
        this.cache = { version: 1, entries: {} };
      }
    },

    get: function(bid) {
      const key = this.makeKey(bid);
      if (!key || !this.cache.entries[key]) return null;

      const entry = this.cache.entries[key];
      const date = entry.publicationDateTs ? new Date(entry.publicationDateTs) : null;
      if (!DateUtils.isValidDate(date)) return null;

      return {
        publicationDate: date,
        publicationDateRaw: entry.publicationDateRaw || DateUtils.formatDate(date),
        pdfBidNo: entry.pdfBidNo || '',
        updatedAt: entry.updatedAt || 0
      };
    },

    set: function(bid, data) {
      const key = this.makeKey(bid);
      if (!key || !data || !DateUtils.isValidDate(data.publicationDate)) return;

      this.cache.entries[key] = {
        publicationDateTs: data.publicationDate.getTime(),
        publicationDateRaw: data.publicationDateRaw || DateUtils.formatDate(data.publicationDate),
        pdfBidNo: data.pdfBidNo || '',
        updatedAt: Date.now()
      };

      this.dirty = true;
      this.dirtyCount += 1;
    },

    flushIfNeeded: async function(force) {
      if (!force && this.dirtyCount < 25) return;
      await this.flush();
    },

    flush: async function() {
      if (!this.dirty || !this.isAvailable()) return;

      this.prune(CACHE_CONFIG.maxEntries);

      try {
        await chromeStorageSet('local', {
          [CACHE_CONFIG.storageKey]: this.cache
        });
        this.dirty = false;
        this.dirtyCount = 0;
      } catch (error) {
        this.prune(Math.floor(CACHE_CONFIG.maxEntries / 2));
        try {
          await chromeStorageSet('local', {
            [CACHE_CONFIG.storageKey]: this.cache
          });
          this.dirty = false;
          this.dirtyCount = 0;
        } catch (secondError) {
          this.dirty = true;
        }
      }
    },

    prune: function(maxEntries) {
      const entries = this.cache.entries || {};
      const keys = Object.keys(entries);
      if (keys.length <= maxEntries) return;

      keys.sort((a, b) => {
        const aTime = entries[a] && entries[a].updatedAt ? entries[a].updatedAt : 0;
        const bTime = entries[b] && entries[b].updatedAt ? entries[b].updatedAt : 0;
        return bTime - aTime;
      });

      keys.slice(maxEntries).forEach((key) => {
        delete entries[key];
      });
    },

    makeKey: function(bid) {
      if (!bid) return '';
      const bidNo = bid.bidNo || 'unknown-bid';
      const url = bid.bidDocumentUrl || bid.bidLink || '';
      if (!url) return '';
      return bidNo + '|' + url;
    }
  };

  // ============================================
  // PDF DATE EXTRACTOR
  // ============================================

  const PDFDateExtractor = {
    pdfjsPromise: null,

    loadPdfJs: async function() {
      if (this.pdfjsPromise) return this.pdfjsPromise;

      this.pdfjsPromise = import(chrome.runtime.getURL(PDFJS_CONFIG.libraryPath)).then((pdfjsLib) => {
        pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL(PDFJS_CONFIG.workerPath);
        return pdfjsLib;
      });

      return this.pdfjsPromise;
    },

    enrichBid: async function(bid, options) {
      const opts = options || {};
      if (!bid) return bid;
      if (DateUtils.isValidDate(bid.publicationDate)) {
        bid.extractionStatus = bid.extractionStatus || 'ok';
        return bid;
      }

      await CacheManager.load();
      const cached = CacheManager.get(bid);
      if (cached) {
        applyPublicationDate(bid, cached.publicationDate, cached.publicationDateRaw, 'cached', cached.pdfBidNo);
        return bid;
      }

      if (!bid.bidDocumentUrl) {
        bid.extractionStatus = 'no-document-url';
        bid.extractionError = 'No bid document link found';
        return bid;
      }

      try {
        const extracted = await this.extractFromUrl(bid.bidDocumentUrl, {
          signal: opts.signal,
          controllerRegistry: opts.controllerRegistry,
          fetchTimeoutMs: opts.fetchTimeoutMs || CONFIG.pdfFetchTimeoutMs,
          parseTimeoutMs: opts.parseTimeoutMs || CONFIG.pdfParseTimeoutMs
        });
        applyPublicationDate(
          bid,
          extracted.publicationDate,
          extracted.publicationDateRaw,
          'ok',
          extracted.pdfBidNo
        );
        CacheManager.set(bid, extracted);
        await CacheManager.flushIfNeeded(false);
      } catch (error) {
        markBidUnavailable(bid, error);
      }

      return bid;
    },

    extractFromUrl: async function(url, options) {
      const opts = Object.assign({
        signal: null,
        controllerRegistry: null,
        fetchTimeoutMs: CONFIG.pdfFetchTimeoutMs,
        parseTimeoutMs: CONFIG.pdfParseTimeoutMs
      }, options || {});
      const tracked = createTrackedAbortController(opts.controllerRegistry);
      const controller = tracked.controller;
      let externalAbortHandler = null;

      if (opts.signal) {
        if (opts.signal.aborted) {
          controller.abort();
        } else {
          externalAbortHandler = () => controller.abort();
          opts.signal.addEventListener('abort', externalAbortHandler, { once: true });
        }
      }

      try {
        const totalTimeoutMs = (opts.fetchTimeoutMs || 0) + (opts.parseTimeoutMs || 0);
        return await withTimeout(
          this.extractFromUrlWithController(url, opts, controller),
          totalTimeoutMs,
          'PDF processing timed out',
          () => controller.abort()
        );
      } finally {
        if (opts.signal && externalAbortHandler) {
          opts.signal.removeEventListener('abort', externalAbortHandler);
        }
        tracked.release();
      }
    },

    extractFromUrlWithController: async function(url, options, controller) {
      const response = await withTimeout(fetch(url, {
        credentials: 'include',
        cache: 'no-store',
        signal: controller.signal
      }), options.fetchTimeoutMs, 'PDF fetch timed out', () => controller.abort());

      if (!response.ok) {
        throw new Error('PDF request failed: HTTP ' + response.status);
      }

      const arrayBuffer = await withTimeout(
        response.arrayBuffer(),
        options.fetchTimeoutMs,
        'PDF fetch timed out',
        () => controller.abort()
      );
      let extracted = null;
      let pdfError = null;

      try {
        extracted = await this.extractWithPdfJs(arrayBuffer, {
          parseTimeoutMs: options.parseTimeoutMs
        });
      } catch (error) {
        pdfError = error;
      }

      if (!extracted || !DateUtils.isValidDate(extracted.publicationDate)) {
        extracted = extractPublicationInfoFromText(extractTextFallback(arrayBuffer));
      }

      if (!extracted || !DateUtils.isValidDate(extracted.publicationDate)) {
        if (pdfError && pdfError.message) {
          throw new Error('Dated field not found in PDF: ' + pdfError.message);
        }
        throw new Error('Dated field not found in PDF');
      }

      return extracted;
    },

    extractWithPdfJs: async function(arrayBuffer, options) {
      const opts = Object.assign({
        parseTimeoutMs: CONFIG.pdfParseTimeoutMs
      }, options || {});
      let loadingTask = null;
      let pdf = null;

      const parseWork = async () => {
        const pdfjsLib = await this.loadPdfJs();
        loadingTask = pdfjsLib.getDocument({
          data: new Uint8Array(arrayBuffer),
          disableFontFace: true,
          isEvalSupported: false,
          useSystemFonts: true
        });

        pdf = await loadingTask.promise;
        const maxPages = Math.min(pdf.numPages, PDFJS_CONFIG.pagesToRead);
        let text = '';

        for (let pageNumber = 1; pageNumber <= maxPages; pageNumber++) {
          const page = await pdf.getPage(pageNumber);
          const content = await page.getTextContent();
          const pageText = content.items.map((item) => item && item.str ? item.str : '').join(' ');
          text += pageText + '\n';
        }

        return extractPublicationInfoFromText(text);
      };

      try {
        return await withTimeout(parseWork(), opts.parseTimeoutMs, 'PDF parse timed out', () => {
          destroyPdfResource(pdf);
          destroyPdfResource(loadingTask);
        });
      } finally {
        await destroyPdfResource(pdf);
        if (!pdf) {
          await destroyPdfResource(loadingTask);
        }
      }
    }
  };

  // ============================================
  // BID ENRICHER
  // ============================================

  const BidsEnricher = {
    enrichBids: async function(bids, options) {
      const list = bids || [];
      const opts = Object.assign({
        concurrency: CONFIG.pdfConcurrency,
        controllerRegistry: null,
        fetchTimeoutMs: CONFIG.pdfFetchTimeoutMs,
        parseTimeoutMs: CONFIG.pdfParseTimeoutMs,
        onProgress: null,
        shouldAbort: null
      }, options || {});

      await CacheManager.load();

      let nextIndex = 0;
      let completed = 0;
      const workerCount = Math.min(Math.max(opts.concurrency || 1, 1), list.length || 1);

      const worker = async () => {
        while (nextIndex < list.length) {
          if (opts.shouldAbort && opts.shouldAbort()) break;
          const index = nextIndex;
          nextIndex += 1;

          const bid = list[index];
          const tracked = createTrackedAbortController(opts.controllerRegistry);
          try {
            const maxBidMs = (opts.fetchTimeoutMs || 0) + (opts.parseTimeoutMs || 0) + CONFIG.pdfCleanupTimeoutMs;
            await withTimeout(PDFDateExtractor.enrichBid(bid, {
              signal: tracked.controller.signal,
              controllerRegistry: opts.controllerRegistry,
              fetchTimeoutMs: opts.fetchTimeoutMs,
              parseTimeoutMs: opts.parseTimeoutMs
            }), maxBidMs, 'PDF processing timed out', () => tracked.controller.abort());
          } catch (error) {
            markBidUnavailable(bid, error);
          } finally {
            tracked.release();
            completed += 1;

            if (opts.onProgress) {
              opts.onProgress(completed, list.length, bid);
            }
          }
        }
      };

      const workers = [];
      for (let i = 0; i < workerCount; i++) {
        workers.push(worker());
      }

      await Promise.all(workers);
      await CacheManager.flush();
      return list;
    }
  };

  // ============================================
  // PAGINATION UTILITIES
  // ============================================

  const PaginationUtils = {
    getPageInfo: function() {
      const info = {
        totalPages: 0,
        currentPage: 1,
        pageSize: 0,
        totalRecords: 0
      };

      const summary = this.getSummaryInfo();
      if (summary) {
        info.pageSize = summary.end - summary.start + 1;
        info.totalRecords = summary.total;
        if (info.pageSize > 0) {
          info.totalPages = Math.ceil(info.totalRecords / info.pageSize);
          info.currentPage = Math.ceil(summary.end / info.pageSize);
        }
      }

      const pageNumbers = this.getPaginationNumbers();
      if (pageNumbers.length > 0) {
        const maxPage = Math.max.apply(null, pageNumbers);
        info.totalPages = Math.max(info.totalPages, maxPage);
      }

      const detectedCurrent = this.getCurrentPageNumber();
      if (detectedCurrent) {
        info.currentPage = detectedCurrent;
      }

      return info;
    },

    getSummaryInfo: function() {
      const bodyText = normalizeWhitespace(document.body ? document.body.textContent || '' : '');
      if (!bodyText) return null;
      const regex = /showing\s+(\d+)\s*(?:-|to)\s*(\d+)\s*(?:records\s*)?of\s*(\d+)/i;
      const match = bodyText.match(regex);
      if (!match) return null;
      return {
        start: parseInt(match[1], 10),
        end: parseInt(match[2], 10),
        total: parseInt(match[3], 10)
      };
    },

    getPaginationNumbers: function() {
      const elements = Array.from(document.querySelectorAll('a, button, li'));
      const numbers = [];

      elements.forEach((el) => {
        const text = normalizeWhitespace(el.textContent || '');
        if (!/^\d+$/.test(text)) return;
        const value = parseInt(text, 10);
        if (isNaN(value) || value <= 0) return;

        const href = el.getAttribute('href') || '';
        const onclick = el.getAttribute('onclick') || '';
        const hasHint = /page/i.test(href) || /page/i.test(onclick) || !!el.closest('.pagination');
        if (hasHint) {
          numbers.push(value);
        }
      });

      return numbers;
    },

    getCurrentPageNumber: function() {
      const hashPage = this.getHashPageNumber();
      if (hashPage) return hashPage;

      const activeSelectors = [
        '.pagination .active',
        '.pagination li.active',
        '.page-item.active',
        '.pagination .current',
        '[aria-current="page"]'
      ];

      for (let i = 0; i < activeSelectors.length; i++) {
        const el = document.querySelector(activeSelectors[i]);
        if (el) {
          const text = normalizeWhitespace(el.textContent || '');
          const num = parseInt(text, 10);
          if (!isNaN(num)) return num;
        }
      }

      const summary = this.getSummaryInfo();
      if (summary && summary.start && summary.end) {
        const pageSize = summary.end - summary.start + 1;
        if (pageSize > 0) {
          return Math.ceil(summary.end / pageSize);
        }
      }

      return null;
    },

    getHashPageNumber: function() {
      const match = window.location.hash.match(/page-?(\d+)/i);
      if (match) {
        const num = parseInt(match[1], 10);
        return isNaN(num) ? null : num;
      }
      return null;
    },

    getPageMode: function() {
      if (this.getHashPattern()) {
        return { mode: 'hash' };
      }

      const builder = this.getPageUrlBuilder();
      if (builder) {
        return { mode: 'query', buildUrl: builder };
      }

      return { mode: 'unknown' };
    },

    getPageUrlBuilder: function() {
      const anchors = Array.from(document.querySelectorAll('a[href]'));
      for (let i = 0; i < anchors.length; i++) {
        const href = anchors[i].getAttribute('href') || '';
        const match = href.match(/[?&](page|pageno|pageNo|pageNumber)=(\d+)/i);
        if (match) {
          const paramName = match[1];
          return function(pageNumber) {
            const url = new URL(href, window.location.href);
            url.searchParams.set(paramName, String(pageNumber));
            return url.toString();
          };
        }
      }

      return null;
    },

    getHashPattern: function() {
      if (this._hashPattern) return this._hashPattern;

      const hash = window.location.hash || '';
      if (/page/i.test(hash)) {
        const match = hash.match(/(.*?)(\d+)(.*)/);
        if (match) {
          this._hashPattern = { prefix: match[1] || '#page-', suffix: match[3] || '' };
          return this._hashPattern;
        }
      }

      const anchors = Array.from(document.querySelectorAll('a[href]'));
      for (let i = 0; i < anchors.length; i++) {
        const href = anchors[i].getAttribute('href') || '';
        if (href.indexOf('#') === 0 && /page/i.test(href)) {
          const match = href.match(/(.*?)(\d+)(.*)/);
          if (match) {
            this._hashPattern = { prefix: match[1], suffix: match[3] || '' };
            return this._hashPattern;
          }
        }
      }

      return null;
    },

    buildHashUrl: function(pageNumber) {
      const pattern = this.getHashPattern() || { prefix: '#page-', suffix: '' };
      const base = window.location.href.split('#')[0];
      return base + pattern.prefix + pageNumber + pattern.suffix;
    },

    setHashPage: function(pageNumber) {
      const pattern = this.getHashPattern() || { prefix: '#page-', suffix: '' };
      const hashValue = (pattern.prefix + pageNumber + pattern.suffix).replace(/^#/, '');
      window.location.hash = hashValue;
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
        '  <h3>GeM Tender Sorter</h3>',
        '  <button class="panel-toggle" aria-label="Toggle panel" type="button">-</button>',
        '</div>',
        '<div class="panel-body">',
        '  <div class="section-label">Current Page</div>',
        '  <div class="button-grid">',
        '    <button class="filter-btn" data-action="published-today" type="button">Published Today</button>',
        '    <button class="filter-btn" data-action="published-week" type="button">Published This Week</button>',
        '    <button class="filter-btn full-width" data-action="published-sort" type="button">Sort by Published Date</button>',
        '    <button class="filter-btn reset-btn full-width" data-action="reset" type="button">Reset</button>',
        '  </div>',
        '  <div class="section-label">All Result Pages</div>',
        '  <div class="button-grid">',
        '    <button class="filter-btn" data-action="scan-today" type="button">Scan All: Today</button>',
        '    <button class="filter-btn" data-action="scan-week" type="button">Scan All: This Week</button>',
        '    <button class="filter-btn full-width" data-action="scan-newest" type="button">Scan All: Newest Published</button>',
        '    <button class="filter-btn reset-btn full-width gem-scan-stop" data-action="scan-stop" type="button">Stop Scan</button>',
        '  </div>',
        '  <div class="status-bar info" id="' + CONFIG.scanStatusId + '">All-pages scan idle</div>',
        '  <div class="scan-results" id="' + CONFIG.scanResultsId + '"></div>',
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

          if (action === 'published-today') {
            Controller.showPublishedToday();
          } else if (action === 'published-week') {
            Controller.showPublishedThisWeek();
          } else if (action === 'published-sort') {
            Controller.sortByPublicationDate();
          } else if (action === 'reset') {
            Controller.reset();
          } else if (action === 'scan-today') {
            Controller.scanAllPages('today');
          } else if (action === 'scan-week') {
            Controller.scanAllPages('week');
          } else if (action === 'scan-newest') {
            Controller.scanAllPages('newest');
          } else if (action === 'scan-stop') {
            Controller.stopScan();
          }
        });
      });
    },

    updateStatus: function(message, type) {
      const status = document.getElementById(CONFIG.statusId);
      if (!status) return;

      status.textContent = message;
      status.classList.remove('info', 'warning');
      status.classList.add(type === 'warning' ? 'warning' : 'info');
    },

    updateScanStatus: function(message, type) {
      const status = document.getElementById(CONFIG.scanStatusId);
      if (!status) return;

      status.textContent = message;
      status.classList.remove('info', 'warning');
      status.classList.add(type === 'warning' ? 'warning' : 'info');
    },

    setScanRunning: function(isRunning) {
      const panel = document.getElementById(CONFIG.panelId);
      if (!panel) return;

      const scanButtons = panel.querySelectorAll('[data-action^="scan-"]');
      scanButtons.forEach((button) => {
        const action = button.getAttribute('data-action');
        if (action === 'scan-stop') return;
        button.disabled = isRunning;
      });

      const stopButton = panel.querySelector('.gem-scan-stop');
      if (stopButton) {
        stopButton.style.display = isRunning ? 'inline-flex' : 'none';
        stopButton.disabled = !isRunning;
      }
    },

    setCurrentPageBusy: function(isBusy) {
      const panel = document.getElementById(CONFIG.panelId);
      if (!panel) return;
      const actions = ['published-today', 'published-week', 'published-sort'];
      actions.forEach((action) => {
        const button = panel.querySelector('[data-action="' + action + '"]');
        if (button) button.disabled = isBusy;
      });
    },

    clearScanResults: function() {
      const container = document.getElementById(CONFIG.scanResultsId);
      if (!container) return;
      container.textContent = '';
      container.classList.remove('active');
    },

    renderScanResults: function(results, meta) {
      const container = document.getElementById(CONFIG.scanResultsId);
      if (!container) return;

      container.textContent = '';
      container.classList.add('active');

      const allResults = results || [];
      const dated = allResults.filter((bid) => DateUtils.isValidDate(bid.publicationDate));
      const unavailable = allResults.filter((bid) => !DateUtils.isValidDate(bid.publicationDate));
      const maxShown = meta && meta.maxShown ? meta.maxShown : CONFIG.maxShownResults;
      const unavailableLimit = meta && meta.unavailableLimit ? meta.unavailableLimit : CONFIG.maxUnavailableShown;

      const summary = document.createElement('div');
      summary.className = 'scan-summary';
      const datedText = dated.length > maxShown
        ? ('Showing newest ' + maxShown + ' of ' + dated.length + ' dated tenders')
        : ('Showing ' + dated.length + ' dated tenders');
      const unavailableText = unavailable.length ? (' | Date unavailable: ' + unavailable.length) : '';
      summary.textContent = datedText + unavailableText;
      container.appendChild(summary);

      if (allResults.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'scan-empty';
        empty.textContent = 'No matching tenders found.';
        container.appendChild(empty);
        return;
      }

      dated.slice(0, maxShown).forEach((bid) => {
        container.appendChild(this.createResultItem(bid, false));
      });

      if (unavailable.length > 0) {
        const section = document.createElement('div');
        section.className = 'scan-result-section';
        section.textContent = 'Date unavailable';
        container.appendChild(section);

        unavailable.slice(0, unavailableLimit).forEach((bid) => {
          container.appendChild(this.createResultItem(bid, true));
        });
      }
    },

    createResultItem: function(bid, unavailable) {
      const item = document.createElement('div');
      item.className = 'scan-result-item' + (unavailable ? ' unavailable' : '');

      const title = document.createElement('div');
      title.className = 'scan-result-title';

      const linkUrl = safeUrl(bid.bidDocumentUrl || bid.bidLink || bid.sourceUrl);
      if (linkUrl) {
        const link = document.createElement('a');
        link.href = linkUrl;
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = bid.bidNo || 'Open bid document';
        title.appendChild(link);
      } else {
        title.textContent = bid.bidNo || 'Bid';
      }

      const metaLine = document.createElement('div');
      metaLine.className = 'scan-result-meta';
      const publishedText = bid.publicationDateRaw || (bid.publicationDate ? DateUtils.formatDate(bid.publicationDate) : 'Unavailable');
      const startText = bid.listingStartDateRaw || 'Unknown start';
      const endText = bid.listingEndDateRaw || 'Unknown end';
      const pageText = bid.sourcePageNumber || bid.pageNumber ? ('Page ' + (bid.sourcePageNumber || bid.pageNumber)) : 'Page unknown';
      metaLine.textContent = 'Published: ' + publishedText + ' | Start: ' + startText + ' | End: ' + endText + ' | ' + pageText;

      item.appendChild(title);
      item.appendChild(metaLine);

      if (bid.department) {
        const dept = document.createElement('div');
        dept.className = 'scan-result-desc';
        dept.textContent = bid.department;
        item.appendChild(dept);
      }

      if (bid.items) {
        const desc = document.createElement('div');
        desc.className = 'scan-result-desc';
        desc.textContent = bid.items;
        item.appendChild(desc);
      }

      if (unavailable) {
        const status = document.createElement('div');
        status.className = 'scan-result-status';
        status.textContent = bid.extractionError || 'PDF Dated field could not be read.';
        item.appendChild(status);
      }

      return item;
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
  // SCAN MANAGER
  // ============================================

  const ScanManager = {
    running: false,
    abort: false,
    results: [],
    collectedBids: [],
    seen: new Set(),
    lastMode: null,
    activeControllers: new Set(),

    scan: async function(mode) {
      if (this.running) return;
      this.running = true;
      this.abort = false;
      this.abortActiveRequests();
      this.results = [];
      this.collectedBids = [];
      this.seen = new Set();
      this.lastMode = mode;

      UIManager.setScanRunning(true);
      UIManager.clearScanResults();
      UIManager.updateScanStatus('Collecting tenders from result pages...', 'info');

      let pageInfo = PaginationUtils.getPageInfo();
      if (!pageInfo.totalPages || pageInfo.totalPages < 1) {
        pageInfo = {
          totalPages: 1,
          currentPage: 1,
          pageSize: 0,
          totalRecords: 0,
          fallbackCurrentPageOnly: true
        };
      }

      const pageMode = PaginationUtils.getPageMode();
      let errorCount = 0;

      if (pageInfo.totalPages === 1 || pageInfo.fallbackCurrentPageOnly) {
        this.collectedBids = DOMParser.parseAllBids({ pageNumber: pageInfo.currentPage || 1 });
      } else if (pageMode.mode === 'hash') {
        errorCount = await this.collectByHash(pageInfo);
      } else if (pageMode.mode === 'query' && pageMode.buildUrl) {
        errorCount = await this.collectByFetch(pageInfo, pageMode.buildUrl);
      } else {
        UIManager.updateScanStatus('Unable to detect pagination. Parsed current page only.', 'warning');
        this.collectedBids = DOMParser.parseAllBids({ pageNumber: pageInfo.currentPage || 1 });
      }

      this.collectedBids = dedupeBids(this.collectedBids);

      if (this.abort) {
        this.results = this.filterResults(this.collectedBids, mode);
        this.results = FilterEngine.sortByPublicationDate(this.results);
        this.finishScan(true, pageInfo, errorCount);
        return;
      }

      if (this.collectedBids.length === 0) {
        this.finishScan(false, pageInfo, errorCount);
        return;
      }

      UIManager.updateScanStatus('Collected ' + this.collectedBids.length + ' tenders. Parsing PDFs...', 'info');

      await BidsEnricher.enrichBids(this.collectedBids, {
        concurrency: CONFIG.pdfConcurrency,
        controllerRegistry: this.activeControllers,
        fetchTimeoutMs: CONFIG.pdfFetchTimeoutMs,
        parseTimeoutMs: CONFIG.pdfParseTimeoutMs,
        shouldAbort: () => this.abort,
        onProgress: (done, total) => {
          const unavailable = FilterEngine.getDateUnavailable(this.collectedBids).length;
          const unavailableText = unavailable > 0 ? (' - ' + unavailable + ' unavailable') : '';
          UIManager.updateScanStatus('Parsed ' + done + ' / ' + total + ' tenders' + unavailableText, 'info');
        }
      });

      this.results = this.filterResults(this.collectedBids, mode);
      this.results = FilterEngine.sortByPublicationDate(this.results);
      this.finishScan(this.abort, pageInfo, errorCount);
    },

    stop: function() {
      if (!this.running) return;
      this.abort = true;
      this.abortActiveRequests();
      UIManager.updateScanStatus('Stopping scan. Active requests aborted...', 'warning');
    },

    abortActiveRequests: function() {
      this.activeControllers.forEach((controller) => {
        try {
          controller.abort();
        } catch (error) {
          // Ignore already-finished requests.
        }
      });
      this.activeControllers.clear();
    },

    finishScan: function(stoppedEarly, pageInfo, errorCount) {
      this.running = false;
      UIManager.setScanRunning(false);

      UIManager.renderScanResults(this.results, {
        maxShown: CONFIG.maxShownResults,
        unavailableLimit: CONFIG.maxUnavailableShown
      });

      const unavailableCount = FilterEngine.getDateUnavailable(this.results).length;
      const unavailableText = unavailableCount > 0 ? (' Date unavailable: ' + unavailableCount + '.') : '';

      if (stoppedEarly || this.abort) {
        UIManager.updateScanStatus('Scan stopped. Showing parsed results.' + unavailableText, 'warning');
        return;
      }

      const fallbackText = pageInfo && pageInfo.fallbackCurrentPageOnly ? ' Current page only.' : '';
      const errorText = errorCount > 0 ? (' Completed with ' + errorCount + ' page errors.') : '';
      UIManager.updateScanStatus('Scan complete. Found ' + this.results.length + ' tenders.' + unavailableText + fallbackText + errorText, 'info');
    },

    collectByFetch: async function(pageInfo, buildUrl) {
      const total = pageInfo.totalPages;
      let errorCount = 0;
      const collected = [];

      for (let page = 1; page <= total; page++) {
        if (this.abort) break;
        UIManager.updateScanStatus('Collecting page ' + page + ' of ' + total, 'info');

        const url = buildUrl(page);
        const tracked = createTrackedAbortController(this.activeControllers);
        try {
          const response = await withTimeout(fetch(url, {
            credentials: 'include',
            signal: tracked.controller.signal
          }), CONFIG.pageFetchTimeoutMs, 'Page fetch timed out', () => tracked.controller.abort());
          if (!response.ok) {
            errorCount += 1;
            continue;
          }

          const html = await withTimeout(
            response.text(),
            CONFIG.pageFetchTimeoutMs,
            'Page fetch timed out',
            () => tracked.controller.abort()
          );
          const doc = new window.DOMParser().parseFromString(html, 'text/html');
          const bids = DOMParser.parseAllBidsFromRoot(doc, {
            baseUrl: url,
            pageNumber: page,
            scanOrderOffset: collected.length
          });
          collected.push.apply(collected, bids);
        } catch (error) {
          if (!this.abort) {
            errorCount += 1;
          }
        } finally {
          tracked.release();
        }

        await sleep(150);
      }

      this.collectedBids = collected;
      return errorCount;
    },

    collectByHash: async function(pageInfo) {
      const total = pageInfo.totalPages;
      const originalHash = window.location.hash;
      let errorCount = 0;
      let previousSignature = getPageSignature();
      const collected = [];

      for (let page = 1; page <= total; page++) {
        if (this.abort) break;
        UIManager.updateScanStatus('Collecting page ' + page + ' of ' + total, 'info');

        const currentPage = PaginationUtils.getCurrentPageNumber();
        if (currentPage !== page) {
          PaginationUtils.setHashPage(page);
          const changed = await waitForPageUpdate(page, previousSignature, CONFIG.pageFetchTimeoutMs, () => this.abort);
          if (!changed) {
            errorCount += 1;
          }
        }

        previousSignature = getPageSignature();
        const pageUrl = PaginationUtils.buildHashUrl(page);
        const bids = DOMParser.parseAllBids({
          baseUrl: pageUrl,
          pageNumber: page,
          scanOrderOffset: collected.length
        });
        collected.push.apply(collected, bids);

        await sleep(150);
      }

      if (originalHash) {
        window.location.hash = originalHash.replace(/^#/, '');
      }

      this.collectedBids = collected;
      return errorCount;
    },

    filterResults: function(bids, mode) {
      const renderable = FilterEngine.getRenderableResults(bids);
      const unavailable = FilterEngine.getDateUnavailable(renderable);

      if (mode === 'today') {
        return FilterEngine.filterPublishedToday(renderable).concat(unavailable);
      }

      if (mode === 'week') {
        return FilterEngine.filterPublishedThisWeek(renderable).concat(unavailable);
      }

      return renderable;
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
    currentOperationId: 0,
    currentPageBusy: false,
    currentPageControllers: new Set(),

    init: function() {
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
      UIManager.setScanRunning(false);
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
        this.showPublishedToday({
          setActive: false,
          resetView: true,
          statusMessage: 'Auto-highlighted tenders published today'
        });
      } else if (this.settings.hideOldBids) {
        this.hideBidsOlderThanPublished(7);
      }
    },

    observePageChanges: function() {
      let refreshTimer = null;

      const observer = new MutationObserver((mutations) => {
        const hasNewNodes = mutations.some((mutation) => this.isExternalMutation(mutation));
        if (!hasNewNodes) return;
        if (this.currentPageBusy || ScanManager.running) return;

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

    isExternalMutation: function(mutation) {
      const panel = document.getElementById(CONFIG.panelId);
      if (!mutation || !mutation.addedNodes || mutation.addedNodes.length === 0) return false;
      if (!panel) return true;
      if (panel && (mutation.target === panel || panel.contains(mutation.target))) return false;

      return Array.from(mutation.addedNodes).some((node) => {
        if (node === panel) return false;
        if (node.nodeType === Node.ELEMENT_NODE) {
          return !panel.contains(node);
        }
        const parent = node.parentElement || mutation.target;
        return !panel.contains(parent);
      });
    },

    reapplyActiveFilter: function(reason) {
      if (this.activeFilter === 'published-today') {
        this.showPublishedToday({ setActive: false, resetView: true });
      } else if (this.activeFilter === 'published-week') {
        this.showPublishedThisWeek({ setActive: false, resetView: true });
      } else if (this.activeFilter === 'published-sort') {
        this.sortByPublicationDate({ setActive: false });
      } else {
        if (reason === 'settings-change' && !this.settings.hideOldBids) {
          UIManager.showHiddenBids();
        }
        this.applySettings();
      }
    },

    getCurrentPageBidsWithPublicationDates: async function(statusPrefix, operationId) {
      const allBids = DOMParser.parseAllBids();
      if (allBids.length === 0) {
        UIManager.updateStatus('No bid cards found on this page', 'warning');
        return [];
      }

      await BidsEnricher.enrichBids(allBids, {
        concurrency: CONFIG.pdfConcurrency,
        controllerRegistry: this.currentPageControllers,
        fetchTimeoutMs: CONFIG.pdfFetchTimeoutMs,
        parseTimeoutMs: CONFIG.pdfParseTimeoutMs,
        shouldAbort: () => operationId !== this.currentOperationId,
        onProgress: (done, total) => {
          if (operationId !== this.currentOperationId) return;
          const unavailable = FilterEngine.getDateUnavailable(allBids).length;
          const unavailableText = unavailable > 0 ? (' - ' + unavailable + ' unavailable') : '';
          UIManager.updateStatus((statusPrefix || 'Parsing PDFs') + ': ' + done + ' / ' + total + unavailableText, 'info');
        }
      });

      return allBids;
    },

    showPublishedToday: async function(options) {
      const opts = Object.assign({
        setActive: true,
        resetView: true,
        statusMessage: null
      }, options || {});

      this.abortCurrentPageRequests();
      const operationId = ++this.currentOperationId;
      this.currentPageBusy = true;
      UIManager.setCurrentPageBusy(true);

      try {
        if (opts.resetView) UIManager.showAllBids();
        const allBids = await this.getCurrentPageBidsWithPublicationDates('Parsing publication dates', operationId);
        if (operationId !== this.currentOperationId) return;

        const todaysBids = FilterEngine.filterPublishedToday(allBids);
        if (todaysBids.length > 0) {
          UIManager.highlightBids(todaysBids, CONFIG.highlightClass);
        }

        const message = opts.statusMessage || ('Found ' + todaysBids.length + ' tenders published today');
        UIManager.updateStatus(message, todaysBids.length > 0 ? 'info' : 'warning');

        if (opts.setActive) {
          this.activeFilter = 'published-today';
          UIManager.setActiveButton('published-today');
        }

        if (this.settings.hideOldBids) {
          this.hideBidsOlderThanPublished(7, allBids);
        }
      } finally {
        if (operationId === this.currentOperationId) {
          this.currentPageBusy = false;
          this.abortCurrentPageRequests();
          UIManager.setCurrentPageBusy(false);
        }
      }
    },

    showPublishedThisWeek: async function(options) {
      const opts = Object.assign({
        setActive: true,
        resetView: true
      }, options || {});

      this.abortCurrentPageRequests();
      const operationId = ++this.currentOperationId;
      this.currentPageBusy = true;
      UIManager.setCurrentPageBusy(true);

      try {
        if (opts.resetView) UIManager.showAllBids();
        const allBids = await this.getCurrentPageBidsWithPublicationDates('Parsing publication dates', operationId);
        if (operationId !== this.currentOperationId) return;

        const weekBids = FilterEngine.filterPublishedThisWeek(allBids);
        if (weekBids.length > 0) {
          UIManager.highlightBids(weekBids, CONFIG.weekHighlightClass);
        }

        UIManager.updateStatus('Found ' + weekBids.length + ' tenders published this week', weekBids.length > 0 ? 'info' : 'warning');

        if (opts.setActive) {
          this.activeFilter = 'published-week';
          UIManager.setActiveButton('published-week');
        }

        if (this.settings.hideOldBids) {
          this.hideBidsOlderThanPublished(7, allBids);
        }
      } finally {
        if (operationId === this.currentOperationId) {
          this.currentPageBusy = false;
          this.abortCurrentPageRequests();
          UIManager.setCurrentPageBusy(false);
        }
      }
    },

    sortByPublicationDate: async function(options) {
      const opts = Object.assign({
        setActive: true
      }, options || {});

      this.abortCurrentPageRequests();
      const operationId = ++this.currentOperationId;
      this.currentPageBusy = true;
      UIManager.setCurrentPageBusy(true);

      try {
        UIManager.showAllBids();
        const allBids = await this.getCurrentPageBidsWithPublicationDates('Parsing publication dates', operationId);
        if (operationId !== this.currentOperationId) return;

        const sorted = FilterEngine.sortByPublicationDate(allBids);
        const container = DOMParser.findBestContainer(sorted);
        if (!container) {
          UIManager.updateStatus('Unable to locate bid list to sort', 'warning');
          return;
        }

        const hasPublicationDates = sorted.some((bid) => DateUtils.isValidDate(bid.publicationDate));
        if (!hasPublicationDates) {
          UIManager.updateStatus('No PDF published dates found to sort', 'warning');
          return;
        }

        sorted.forEach((bid) => {
          const target = bid.sortElement || bid.element;
          if (target && target.parentElement === container) {
            container.appendChild(target);
          }
        });

        UIManager.updateStatus('Sorted by PDF published date', 'info');

        if (opts.setActive) {
          this.activeFilter = 'published-sort';
          UIManager.setActiveButton('published-sort');
        }

        if (this.settings.hideOldBids) {
          this.hideBidsOlderThanPublished(7, allBids);
        }
      } finally {
        if (operationId === this.currentOperationId) {
          this.currentPageBusy = false;
          this.abortCurrentPageRequests();
          UIManager.setCurrentPageBusy(false);
        }
      }
    },

    reset: function() {
      this.currentOperationId += 1;
      this.currentPageBusy = false;
      this.abortCurrentPageRequests();
      UIManager.setCurrentPageBusy(false);
      UIManager.showAllBids();
      this.restoreOriginalOrder();
      this.activeFilter = null;
      UIManager.setActiveButton(null);
      UIManager.updateStatus('Filters reset', 'info');

      if (this.settings.hideOldBids) {
        this.hideBidsOlderThanPublished(7);
      }
    },

    scanAllPages: function(mode) {
      ScanManager.scan(mode);
    },

    stopScan: function() {
      ScanManager.stop();
    },

    abortCurrentPageRequests: function() {
      this.currentPageControllers.forEach((controller) => {
        try {
          controller.abort();
        } catch (error) {
          // Ignore already-finished requests.
        }
      });
      this.currentPageControllers.clear();
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

    hideBidsOlderThanPublished: async function(days, existingBids) {
      const operationId = this.currentOperationId;
      const allBids = existingBids || await this.getCurrentPageBidsWithPublicationDates('Parsing publication dates', operationId);
      const toHide = allBids.filter((bid) => {
        if (!DateUtils.isValidDate(bid.publicationDate)) return false;
        return !DateUtils.isWithinDays(bid.publicationDate, days);
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
    return String(text || '').replace(/\s+/g, ' ').trim();
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
    if (countRegexMatches(text, /bid\s*no/ig) > 2) return false;
    return true;
  }

  function extractBidNo(cardElement) {
    if (!cardElement) return '';
    const text = normalizeWhitespace(cardElement.textContent || '');
    const labeled = text.match(/bid\s*no\.?\s*:?\s*(GEM\/\d{4}\/B\/\d+)/i);
    if (labeled && labeled[1]) return labeled[1];
    const fallback = text.match(/\bGEM\/\d{4}\/B\/\d+\b/i);
    return fallback ? fallback[0] : '';
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
            '\\s*:?\\s*(\\d{1,2}[-/]\\d{1,2}[-/]\\d{4}(?:\\s+\\d{1,2}:\\d{2}(?::\\d{2})?\\s*(?:AM|PM)?)?)',
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

  function trimExtractedValue(value) {
    const text = normalizeWhitespace(value);
    if (!text) return '';
    const markers = [
      /\s+Quantity\b/i,
      /\s+Department\s+Name\b/i,
      /\s+Start\s+Date\b/i,
      /\s+End\s+Date\b/i,
      /\s+Bid\s+No\b/i,
      /\s+RA\s+NO\b/i
    ];

    let end = text.length;
    markers.forEach((marker) => {
      const match = text.match(marker);
      if (match && typeof match.index === 'number') {
        end = Math.min(end, match.index);
      }
    });

    return text.slice(0, end).trim();
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

  function findCardContainerFromNode(element, root) {
    const stopRoot = root || document.body;
    let el = element;
    while (el && el !== stopRoot) {
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

  function extractBidLink(cardElement, bidNo, baseUrl) {
    if (!cardElement) return '';
    const anchors = Array.from(cardElement.querySelectorAll('a[href]'));
    if (anchors.length === 0) return '';

    if (bidNo) {
      const bidAnchor = anchors.find((anchor) => {
        const text = normalizeWhitespace(anchor.textContent || '');
        const href = anchor.getAttribute('href') || '';
        return text.indexOf(bidNo) !== -1 || href.indexOf(encodeURIComponent(bidNo)) !== -1 || href.indexOf(bidNo) !== -1;
      });
      if (bidAnchor) {
        return resolveUrl(bidAnchor.getAttribute('href'), baseUrl);
      }
    }

    const documentAnchor = anchors.find((anchor) => {
      const text = normalizeWhitespace(anchor.textContent || '');
      const href = anchor.getAttribute('href') || '';
      return /bid/i.test(text) || /bidding|bid|document|show/i.test(href);
    });

    const target = documentAnchor || anchors[0];
    return resolveUrl(target.getAttribute('href'), baseUrl);
  }

  function resolveUrl(url, baseUrl) {
    if (!url) return '';
    try {
      return new URL(url, baseUrl || window.location.href).toString();
    } catch (error) {
      return '';
    }
  }

  function safeUrl(url) {
    if (!url) return '';
    try {
      const resolved = new URL(url, window.location.href);
      if (resolved.protocol === 'http:' || resolved.protocol === 'https:') {
        return resolved.toString();
      }
    } catch (error) {
      return '';
    }
    return '';
  }

  function readElementPublicationDate(element) {
    if (!element) return null;
    const attr = element.getAttribute(CONFIG.publicationDateAttr);
    if (!attr) return null;
    const ts = parseInt(attr, 10);
    if (isNaN(ts)) return null;
    const date = new Date(ts);
    return DateUtils.isValidDate(date) ? date : null;
  }

  function applyPublicationDate(bid, date, raw, status, pdfBidNo) {
    bid.publicationDate = date;
    bid.publicationDateRaw = raw || DateUtils.formatDate(date);
    bid.extractionStatus = status || 'ok';
    bid.extractionError = '';
    bid.pdfBidNo = pdfBidNo || '';

    const element = bid.element;
    if (element && DateUtils.isValidDate(date)) {
      element.setAttribute(CONFIG.publicationDateAttr, String(date.getTime()));
      element.setAttribute(CONFIG.publicationDateRawAttr, bid.publicationDateRaw);
    }
  }

  function extractPublicationInfoFromText(text) {
    const normalized = normalizeWhitespace(text);
    if (!normalized) return null;

    const bidMatch = normalized.match(/\bGEM\/\d{4}\/B\/\d+\b/i);
    const datePatterns = [
      /Dated\s*:?\s*(\d{1,2}[-/]\d{1,2}[-/]\d{4})/i,
      /Dated\s+(\d{1,2}[-/]\d{1,2}[-/]\d{4})/i
    ];

    let rawDate = '';
    for (let i = 0; i < datePatterns.length; i++) {
      const match = normalized.match(datePatterns[i]);
      if (match && match[1]) {
        rawDate = match[1];
        break;
      }
    }

    const publicationDate = DateUtils.parseGemDate(rawDate);
    if (!DateUtils.isValidDate(publicationDate)) return null;

    return {
      publicationDate: publicationDate,
      publicationDateRaw: rawDate,
      pdfBidNo: bidMatch ? bidMatch[0] : ''
    };
  }

  function extractTextFallback(arrayBuffer) {
    try {
      const bytes = new Uint8Array(arrayBuffer);
      const maxBytes = Math.min(bytes.length, 250000);
      const slice = bytes.slice(0, maxBytes);
      return new TextDecoder('iso-8859-1').decode(slice)
        .replace(/\0/g, ' ')
        .replace(/[()<>[\]{}]/g, ' ');
    } catch (error) {
      return '';
    }
  }

  function dedupeBids(bids) {
    const seen = new Set();
    const result = [];
    (bids || []).forEach((bid, index) => {
      const key = buildBidKey(bid);
      if (!key || seen.has(key)) return;
      seen.add(key);
      bid.scanOrder = typeof bid.scanOrder === 'number' ? bid.scanOrder : index;
      result.push(bid);
    });
    return result;
  }

  function buildBidKey(bid) {
    if (!bid) return '';
    if (bid.bidNo) return bid.bidNo;
    if (bid.bidDocumentUrl) return bid.bidDocumentUrl;
    const parts = [];
    if (bid.listingStartDate) parts.push(String(bid.listingStartDate.getTime()));
    if (bid.listingStartDateRaw) parts.push(bid.listingStartDateRaw);
    if (bid.items) parts.push(bid.items.slice(0, 80));
    return parts.join('|');
  }

  function getStableOrder(bid) {
    if (!bid) return 0;
    if (typeof bid.scanOrder === 'number') return bid.scanOrder;
    const element = bid.sortElement || bid.element;
    if (!element) return 0;
    return parseInt(element.getAttribute(CONFIG.originalOrderAttr) || '0', 10);
  }

  function getPageSignature() {
    const cards = DOMParser.findBidCards();
    if (!cards || cards.length === 0) return '';
    const samples = cards.slice(0, 2).map((card) => {
      const text = normalizeWhitespace(card.textContent || '');
      return text.slice(0, 120);
    });
    return samples.join('|');
  }

  async function waitForPageUpdate(targetPage, previousSignature, timeoutMs, shouldAbort) {
    const start = Date.now();
    const timeout = timeoutMs || 10000;
    const lastSignature = previousSignature || '';

    while (Date.now() - start < timeout) {
      if (shouldAbort && shouldAbort()) return false;
      const currentPage = PaginationUtils.getCurrentPageNumber();
      const signature = getPageSignature();
      const pageMatches = targetPage ? (currentPage === targetPage || !currentPage) : true;
      if (pageMatches && signature && signature !== lastSignature) {
        return true;
      }
      await sleep(200);
    }

    return false;
  }

  function withTimeout(promise, ms, timeoutMessage, onTimeout) {
    if (!ms || ms <= 0) {
      return Promise.resolve(promise);
    }

    let timeoutId = null;
    const timeoutPromise = new Promise((resolve, reject) => {
      timeoutId = window.setTimeout(() => {
        if (typeof onTimeout === 'function') {
          try {
            onTimeout();
          } catch (error) {
            // Timeout cleanup must not hide the timeout failure.
          }
        }
        const error = new Error(timeoutMessage || 'Operation timed out');
        error.isTimeout = true;
        reject(error);
      }, ms);
    });

    return Promise.race([Promise.resolve(promise), timeoutPromise]).finally(() => {
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
    });
  }

  function createTrackedAbortController(registry) {
    const controller = new AbortController();
    if (registry && typeof registry.add === 'function') {
      registry.add(controller);
    }

    return {
      controller: controller,
      release: function() {
        if (registry && typeof registry.delete === 'function') {
          registry.delete(controller);
        }
      }
    };
  }

  async function destroyPdfResource(resource) {
    if (!resource || typeof resource.destroy !== 'function') return;
    try {
      await withTimeout(
        Promise.resolve(resource.destroy()),
        CONFIG.pdfCleanupTimeoutMs,
        'PDF cleanup timed out'
      );
    } catch (error) {
      // PDF.js can reject destroy calls for already-terminated workers.
    }
  }

  function markBidUnavailable(bid, error) {
    if (!bid) return;
    bid.extractionStatus = 'unavailable';
    bid.extractionError = normalizeExtractionError(error);
  }

  function normalizeExtractionError(error) {
    if (!error) return 'Could not parse PDF date';
    if (error.name === 'AbortError') return 'PDF request aborted';
    const message = error.message || String(error);
    if (/aborted/i.test(message)) return 'PDF request aborted';
    if (/PDF fetch timed out/i.test(message)) return 'PDF fetch timed out';
    if (/PDF parse timed out/i.test(message)) return 'PDF parse timed out';
    if (/PDF processing timed out/i.test(message)) return 'PDF processing timed out';
    if (/Page fetch timed out/i.test(message)) return 'Page fetch timed out';
    return message || 'Could not parse PDF date';
  }

  function chromeStorageGet(area, keys) {
    return new Promise((resolve, reject) => {
      chrome.storage[area].get(keys, (result) => {
        const error = chrome.runtime && chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        resolve(result || {});
      });
    });
  }

  function chromeStorageSet(area, value) {
    return new Promise((resolve, reject) => {
      chrome.storage[area].set(value, () => {
        const error = chrome.runtime && chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        resolve();
      });
    });
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  Controller.init();
})();
