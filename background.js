'use strict';

const notify = e => chrome.notifications.create({
  title: chrome.runtime.getManifest().name,
  type: 'basic',
  iconUrl: 'data/icons/128.png',
  message: e.message || e
});

// https://github.com/rNeomy/auto-tab-discard/issues/24
const isFirefox = navigator.userAgent.indexOf('Firefox') !== -1;

const DELAY = isFirefox ? 500 : 0;

var restore = {
  cache: {}
};
if (isFirefox) {
  chrome.tabs.onActivated.addListener(({tabId}) => {
    const tab = restore.cache[tabId];
    if (tab) {
      chrome.tabs.executeScript(tabId, {
        code: ''
      }, () => {
        const lastError = chrome.runtime.lastError;
        if (lastError && lastError.message === 'No matching message handler') {
          chrome.tabs.update(tabId, {
            url: tab.url
          });
          // console.log('reloading');
        }
      });
    }
  });
  chrome.tabs.onRemoved.addListener(tabId => delete restore.cache[tabId]);
}

chrome.runtime.onMessage.addListener(({method}, {tab}, resposne) => {
  if (method === 'is-pinned') {
    resposne(tab.pinned);
  }
  else if (method === 'is-playing') {
    resposne(tab.audible);
  }
  else if (method === 'discard') {
    if (tab.active) {
      return;
    }
    const next = () => {
      chrome.tabs.discard(tab.id);
      if (isFirefox) {
        restore.cache[tab.id] = tab;
      }
    };
    // favicon
    Object.assign(new Image(), {
      crossOrigin: 'anonymous',
      src: tab.favIconUrl || '/data/page.png',
      onerror: next,
      onload: function() {
        const img = this;
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        canvas.width = img.width;
        canvas.height = img.height;

        ctx.globalAlpha = 0.4;
        ctx.drawImage(img, 0, 0);

        ctx.globalAlpha = 1;
        ctx.beginPath();
        ctx.fillStyle = '#a1a0a1';
        ctx.arc(img.width * 0.75, img.height * 0.75, img.width * 0.25, 0, 2 * Math.PI, false);
        ctx.fill();
        const href = canvas.toDataURL('image/png');

        chrome.tabs.executeScript(tab.id, {
          runAt: 'document_start',
          allFrames: true,
          matchAboutBlank: true,
          code: `

            if (window === window.top) {
              [...document.querySelectorAll('link[rel*="icon"]')].forEach(link => link.remove());

              document.querySelector('head').appendChild(Object.assign(document.createElement('link'), {
                rel: 'icon',
                type: 'image/png',
                href: '${href}'
              }));
            }
            window.stop();
          `,
        }, () => {
          window.setTimeout(next, DELAY);
        });
      }
    });
  }
});

chrome.idle.onStateChanged.addListener(state => {
  if (state === 'active') {
    chrome.tabs.query({
      url: '*://*/*',
      discarded: false
    }, tabs => tabs.forEach(tab => chrome.tabs.sendMessage(tab.id, {
      method: 'idle'
    })));
  }
});

// number-based discarding
{
  const tabs = {
    id: null
  };
  tabs.check = () => {
    window.clearTimeout(tabs.id);
    tabs.id = window.setTimeout(tabs._check, DELAY);
  };
  // https://github.com/rNeomy/auto-tab-discard/issues/21
  tabs.update = (id, info) => {
    if (info.status === 'complete') {
      tabs.check();
    }
  };

  tabs._check = () => {
    const echo = ({id}) => new Promise(resolve => chrome.tabs.sendMessage(id, {
      method: 'introduce'
    }, resolve));
    chrome.tabs.query({
      url: '*://*/*'
    }, tbs => {
      if (tbs.length > 3) {
        Promise.all(tbs.map(echo)).then(arr => {
          arr = arr.filter((a, i) => {
            if (a) {
              arr[i].tabId = tbs[i].id;
              arr[i].title = tbs[i].title;
            }
            return a && a.exception !== true && a.ready === true && tbs[i].active === false;
          });
          //console.log('number of active tabs', arr.length);
          if (arr.length > 3) {
            chrome.storage.local.get({
              number: 6
            }, prefs => {
              if (arr.length > prefs.number) {
                const toBeDiscarded = arr.sort((a, b) => b.now - a.now).slice(prefs.number);
                //console.log(toBeDiscarded);
                toBeDiscarded.forEach(({tabId}) => {
                  chrome.tabs.sendMessage(tabId, {
                    method: 'bypass-discard'
                  });
                });
                //console.log('number of tabs being discarded', toBeDiscarded.length, toBeDiscarded.map(t => t.title));
              }
            });
          }
        });
      }
    });
  };
  tabs.install = () => {
    chrome.tabs.onCreated.addListener(tabs.check);
    chrome.tabs.onUpdated.addListener(tabs.update);
  };
  tabs.uninstall = () => {
    chrome.tabs.onCreated.removeListener(tabs.check);
    chrome.tabs.onUpdated.removeListener(tabs.update);
  };

  chrome.storage.local.get({
    mode: 'timer-based'
  }, prefs => {
    if (prefs.mode === 'number-based') {
      tabs.install();
    }
  });
  chrome.storage.onChanged.addListener(prefs => {
    if (prefs.mode) {
      if (prefs.mode.newValue === 'number-based') {
        tabs.install();
      }
      else {
        tabs.uninstall();
      }
    }
  });
}

// initial inject
{
  const callback = () => chrome.app && chrome.tabs.query({
    url: '*://*/*',
    discarded: false
  }, tabs => {
    const contentScripts = chrome.app.getDetails().content_scripts;
    for (const tab of tabs) {
      for (const cs of contentScripts) {
        chrome.tabs.executeScript(tab.id, {
          file: cs.js[0],
          runAt: cs.run_at,
          allFrames: cs.all_frames,
        });
      }
    }
  });
  // Firefox does not call "onStartup" after enabling the extension
  if (/Firefox/.test(navigator.userAgent)) {
    callback();
  }
  else {
    chrome.runtime.onInstalled.addListener(callback);
    chrome.runtime.onStartup.addListener(callback);
  }
}

// left-click action
{
  const callback = () => chrome.storage.local.get({
    click: 'click.popup'
  }, ({click}) => {
    if (click === 'click.popup') {
      chrome.browserAction.setPopup({
        popup: 'data/popup/index.html'
      });
    }
    else {
      chrome.browserAction.setPopup({
        popup: ''
      });
    }
  });
  // Firefox does not call "onStartup" after enabling the extension
  if (/Firefox/.test(navigator.userAgent)) {
    callback();
  }
  else {
    chrome.runtime.onInstalled.addListener(callback);
    chrome.runtime.onStartup.addListener(callback);
  }
  chrome.storage.onChanged.addListener(prefs => prefs.click && callback());
}

// FAQs & Feedback
chrome.storage.local.get({
  'version': null,
  'faqs': false,
  'last-update': 0,
}, prefs => {
  const version = chrome.runtime.getManifest().version;

  if (prefs.version ? (prefs.faqs && prefs.version !== version) : true) {
    const now = Date.now();
    const doUpdate = (now - prefs['last-update']) / 1000 / 60 / 60 / 24 > 30;
    chrome.storage.local.set({
      version,
      'last-update': doUpdate ? Date.now() : prefs['last-update']
    }, () => {
      // do not display the FAQs page if last-update occurred less than 30 days ago.
      if (doUpdate) {
        const p = Boolean(prefs.version);
        chrome.tabs.create({
          url: chrome.runtime.getManifest().homepage_url + '?version=' + version +
            '&type=' + (p ? ('upgrade&p=' + prefs.version) : 'install'),
          active: p === false
        });
      }
    });
  }
});

{
  const {name, version} = chrome.runtime.getManifest();
  chrome.runtime.setUninstallURL(
    chrome.runtime.getManifest().homepage_url + '?rd=feedback&name=' + name + '&version=' + version
  );
}
