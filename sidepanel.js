'use strict';

const listEl = document.getElementById('list');

chrome.storage.session.get('sideFeed', function (bag) {
  render(bag && bag.sideFeed);
});

chrome.storage.onChanged.addListener(function (changes, area) {
  if (area !== 'session' || !changes.sideFeed) return;
  render(changes.sideFeed.newValue);
});

document.getElementById('clear').addEventListener('click', function () {
  chrome.runtime.sendMessage({ type: 'side-clear' }, function () {
    void chrome.runtime.lastError;
  });
});

function render(feed) {
  const items = Array.isArray(feed) ? feed : [];
  listEl.replaceChildren();
  if (!items.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = '选中网页里的文字后，译文会出现在这里，不盖住正文。如果边栏是自己点开的，保持开着就行。';
    listEl.appendChild(empty);
    return;
  }
  items.forEach(function (item) {
    listEl.appendChild(renderCard(item || {}));
  });
}

function renderCard(item) {
  const card = document.createElement('article');
  card.className = 'card' + (item.state === 'error' ? ' error' : '');

  const text = document.createElement('p');
  text.className = 'text';
  if (item.state === 'loading') text.textContent = '正在翻译…';
  else text.textContent = item.text || (item.state === 'error' ? '翻译失败' : '');
  card.appendChild(text);

  if (item.original) {
    const original = document.createElement('p');
    original.className = 'original';
    original.textContent = item.original;
    card.appendChild(original);
  }

  if (item.state === 'result' && item.text) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = '复制译文';
    button.addEventListener('click', function () {
      copyText(item.text).then(function (ok) {
        button.textContent = ok ? '已复制' : '复制失败';
        setTimeout(function () { button.textContent = '复制译文'; }, 1200);
      });
    });
    card.appendChild(button);
  }
  return card;
}

function copyText(value) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(value).then(function () { return true; }, function () { return false; });
  }
  return Promise.resolve(false);
}
