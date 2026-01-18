// Popup script - handles settings and status

document.addEventListener('DOMContentLoaded', function() {
  if (typeof chrome === 'undefined' || !chrome.tabs || !chrome.storage || !chrome.storage.sync) {
    return;
  }

  // Check if we are on a GeM page
  chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
    const tab = tabs[0];
    const url = (tab && tab.url) ? tab.url : '';

    const statusDot = document.querySelector('.status-dot');
    const statusText = document.querySelector('.status-text');

    if (!statusDot || !statusText) return;

    if (url.indexOf('bidplus.gem.gov.in') !== -1) {
      statusDot.classList.add('active');
      statusText.textContent = 'Active on GeM page';
    } else {
      statusDot.classList.add('inactive');
      statusText.textContent = 'Navigate to GeM bid page to use';
    }
  });

  // Load saved settings
  chrome.storage.sync.get(['autoHighlight', 'hideOldBids'], function(result) {
    const autoHighlight = document.getElementById('auto-highlight');
    const hideOldBids = document.getElementById('hide-old-bids');

    if (autoHighlight) {
      autoHighlight.checked = result.autoHighlight !== false;
    }

    if (hideOldBids) {
      hideOldBids.checked = result.hideOldBids === true;
    }
  });

  // Save settings on change
  const autoHighlight = document.getElementById('auto-highlight');
  if (autoHighlight) {
    autoHighlight.addEventListener('change', function() {
      chrome.storage.sync.set({ autoHighlight: this.checked });
    });
  }

  const hideOldBids = document.getElementById('hide-old-bids');
  if (hideOldBids) {
    hideOldBids.addEventListener('change', function() {
      chrome.storage.sync.set({ hideOldBids: this.checked });
    });
  }
});
