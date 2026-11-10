const $ = selector => document.querySelector(selector);
const cover = $('#closedCover');
const pages = $('#openPages');
const sheet = $('#pageTurn');
const turnFront = $('#turnFront');
const turnBack = $('#turnBack');
const leftPage = $('#leftPage');
const rightPage = $('#rightPage');
const PAGE_KEY = 'book-page-start-v2';
const configured = window.SUPABASE_CONFIG || {};
const supabaseReady = Boolean(window.supabase?.createClient && configured.url?.startsWith('https://') && configured.anonKey && !configured.anonKey.startsWith('PEGA_'));
const sbClient = supabaseReady ? window.supabase.createClient(configured.url, configured.anonKey) : null;
let chapter = null;
let storyPages = [];
let pageStart = Math.max(1, Number(localStorage.getItem(PAGE_KEY) || 1));
let currentUser = null;
let opened = false;
let turning = false;
let soundOn = true;
let accountMode = 'signup';
let progressTimer;
let resizeTimer;
let finishTurn = null;
const smallScreen = window.matchMedia('(max-width: 700px)');

function requireSupabase() {
  if (!sbClient) throw new Error('Falta configurar Supabase. Sigue los pasos del README para activar cuentas y comentarios.');
  return sbClient;
}
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[character]);
}
function splitToLength(text, limit) {
  if (text.length <= limit) return [text];
  const words = text.split(/\s+/);
  const chunks = [];
  let current = '';
  for (const word of words) {
    if (current && `${current} ${word}`.length > limit) { chunks.push(current); current = word; }
    else current = current ? `${current} ${word}` : word;
  }
  if (current) chunks.push(current);
  return chunks;
}
function paginate(capacity = smallScreen.matches ? 520 : 750) {
  if (!chapter) return [];
  const result = [{ paragraphs: [], used: 0 }];
  for (const paragraph of chapter.paragraphs) {
    const parts = splitToLength(paragraph, capacity - 40);
    for (const part of parts) {
      let current = result[result.length - 1];
      const partCost = part.length + 30;
      const budget = result.length === 1 ? capacity - 85 : capacity;
      if (current.paragraphs.length && current.used + partCost > budget) {
        current = { paragraphs: [], used: 0 };
        result.push(current);
      }
      current.paragraphs.push(part);
      current.used += partCost;
    }
  }
  return result;
}
async function buildPages() {
  await document.fonts.ready;
  const viewportCapacity = smallScreen.matches ? 520 : window.innerHeight < 780 ? 490 : window.innerHeight < 950 ? 620 : 750;
  let capacity = viewportCapacity;
  for (let attempt = 0; attempt < 7; attempt++) {
    storyPages = paginate(capacity);
    const probe = document.createElement('div');
    probe.className = `sheet sheet-right${smallScreen.matches ? ' mobile-full' : ''}`;
    probe.style.cssText = `position:fixed;left:-20000px;top:0;width:${smallScreen.matches ? $('#bookScene').clientWidth : $('#bookScene').clientWidth / 2}px;height:${$('#bookScene').clientHeight}px;visibility:hidden;pointer-events:none`;
    document.body.append(probe);
    let overflow = false;
    for (let index = 0; index < storyPages.length; index++) {
      probe.innerHTML = pageMarkup(index);
      const copy = probe.querySelector('.page-copy');
      if (copy && copy.scrollHeight > copy.clientHeight + 2) { overflow = true; break; }
    }
    probe.remove();
    if (!overflow || capacity <= 340) break;
    capacity -= 45;
  }
  pageStart = Math.min(pageStart, storyPages.length);
  render();
}
function pageMarkup(index) {
  const item = storyPages[index];
  if (!item) return '<div class="page-copy empty-page" aria-label="Página en blanco"></div>';
  const paragraphs = item.paragraphs.map(text => `<p>${escapeHtml(text)}</p>`).join('');
  const title = index === 0 ? `<h2 class="chapter-title">${escapeHtml(chapter.title)}</h2>` : '';
  return `<div class="page-copy"><div class="running-head">CAPÍTULO ${String(chapter.number).padStart(2, '0')} <span>·</span> ${escapeHtml(chapter.title.toUpperCase())}</div>${title}<div class="story-text">${paragraphs}</div></div>`;
}
function pageFace(index, side) {
  return `${pageMarkup(index)}<span class="page-number ${side}">${index >= 0 && index < storyPages.length ? index + 1 : ''}</span>`;
}
function render() {
  if (!storyPages.length) return;
  const mobile = smallScreen.matches;
  if (!mobile && pageStart > 1 && pageStart >= storyPages.length) pageStart = Math.max(1, storyPages.length - 1);
  if (mobile) {
    leftPage.innerHTML = '';
    leftPage.classList.add('mobile-hidden');
    rightPage.innerHTML = pageFace(pageStart - 1, 'right');
    rightPage.classList.add('mobile-full');
  } else {
    leftPage.classList.remove('mobile-hidden');
    rightPage.classList.remove('mobile-full');
    leftPage.innerHTML = pageFace(pageStart - 1, 'left');
    rightPage.innerHTML = pageFace(pageStart, 'right');
  }
  const lastStart = mobile ? storyPages.length : Math.max(1, storyPages.length - 1);
  const rightLabel = mobile ? String(Math.min(pageStart, storyPages.length)) : String(Math.min(pageStart + 1, storyPages.length));
  $('#pageCount').textContent = `PÁGINAS ${pageStart}–${rightLabel}`;
  $('#progressFill').style.width = `${Math.min(100, Math.round((pageStart / storyPages.length) * 100))}%`;
  $('#prevBtn').disabled = pageStart <= 1;
  $('#nextBtn').disabled = pageStart >= lastStart;
  localStorage.setItem(PAGE_KEY, pageStart);
  if (currentUser) scheduleProgressSave();
}
function pageSound() {
  if (!soundOn) return;
  try {
    const context = new (window.AudioContext || window.webkitAudioContext)();
    const length = Math.floor(context.sampleRate * .24);
    const buffer = context.createBuffer(1, length, context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length);
    const source = context.createBufferSource();
    const filter = context.createBiquadFilter();
    const gain = context.createGain();
    source.buffer = buffer;
    filter.type = 'lowpass'; filter.frequency.value = 1150;
    gain.gain.setValueAtTime(.12, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(.001, context.currentTime + .22);
    source.connect(filter); filter.connect(gain); gain.connect(context.destination);
    source.start(); source.stop(context.currentTime + .24);
    source.onended = () => context.close();
  } catch (_) { /* Sound is optional when browser audio is unavailable. */ }
}
function openBook() {
  if (opened) return;
  opened = true;
  pageSound();
  $('#bookScene').classList.add('is-open');
  $('#openHint').classList.add('is-hidden');
  cover.classList.add('opening');
  pages.classList.add('visible');
  pages.setAttribute('aria-hidden', 'false');
  $('#readerControls').classList.add('visible');
  render();
}
cover.addEventListener('transitionend', event => {
  if (event.propertyName === 'transform' && cover.classList.contains('opening')) cover.classList.add('settled');
});
function returnToCover() {
  if (finishTurn) {
    sheet.removeEventListener('animationend', finishTurn);
    finishTurn = null;
    turning = false;
    sheet.classList.remove('turning', 'backward');
  }
  opened = false;
  cover.classList.remove('settled', 'opening');
  $('#bookScene').classList.remove('is-open');
  pages.classList.remove('visible');
  pages.setAttribute('aria-hidden', 'true');
  $('#readerControls').classList.remove('visible');
  $('#openHint').classList.remove('is-hidden');
  $('#portada').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function turnPage(direction) {
  if (!opened || turning || !storyPages.length) return;
  const mobile = smallScreen.matches;
  const lastStart = mobile ? storyPages.length : Math.max(1, storyPages.length - 1);
  const nextStart = pageStart + direction;
  if (nextStart < 1 || nextStart > lastStart) return;
  turning = true;
  pageSound();
  sheet.classList.remove('backward', 'turning');
  if (direction < 0) sheet.classList.add('backward');
  const currentIndex = mobile ? pageStart - 1 : direction > 0 ? pageStart : pageStart - 1;
  turnFront.innerHTML = pageFace(currentIndex, direction > 0 ? 'right' : 'left');
  turnBack.innerHTML = pageFace(currentIndex + direction, direction > 0 ? 'left' : 'right');
  void sheet.offsetWidth;
  sheet.classList.add('turning');
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    pageStart = nextStart;
    render();
    sheet.classList.remove('turning', 'backward');
    turning = false;
    return;
  }
  finishTurn = event => {
    if (event.target !== sheet) return;
    sheet.removeEventListener('animationend', finishTurn);
    finishTurn = null;
    pageStart = nextStart;
    render();
    sheet.classList.remove('turning', 'backward');
    turning = false;
  };
  sheet.addEventListener('animationend', finishTurn);
}
function scheduleProgressSave() {
  window.clearTimeout(progressTimer);
  progressTimer = window.setTimeout(async () => {
    try {
      const { error } = await requireSupabase().from('reading_progress').upsert({ page_start: pageStart, updated_at: new Date().toISOString() });
      if (error) throw error;
    } catch (error) { toast(error.message); }
  }, 180);
}
async function loadUserProgress() {
  const { data, error } = await requireSupabase().from('reading_progress').select('page_start').maybeSingle();
  if (error) throw error;
  pageStart = Math.max(1, Math.min(Number(data?.page_start) || 1, storyPages.length));
  render();
}
function updateAccountButton() {
  const label = $('#accountBtn').querySelector('span:last-child');
  const avatar = $('#accountBtn').querySelector('.avatar');
  if (currentUser) {
    label.textContent = currentUser.name;
    avatar.textContent = currentUser.name.slice(0, 1).toUpperCase();
    $('#accountBtn').setAttribute('aria-label', `Cuenta de ${currentUser.name}`);
  } else {
    label.textContent = 'Crear cuenta / Entrar';
    avatar.textContent = '＋';
    $('#accountBtn').setAttribute('aria-label', 'Crear cuenta o iniciar sesión');
  }
}
function setUser(user) {
  currentUser = user ? { id: user.id, email: user.email, name: user.user_metadata?.display_name || user.user_metadata?.name || user.email?.split('@')[0] || 'Lector' } : null;
  updateAccountButton();
}
const backdrop = $('#modalBackdrop');
const modalContent = $('#modalContent');
function showModal(html) { modalContent.innerHTML = html; backdrop.classList.add('show'); }
function closeModal() { backdrop.classList.remove('show'); }
function accountForm() {
  if (currentUser) {
    showModal(`<div class="eyebrow" style="justify-content:flex-start;color:#438da0">TU ESPACIO DE LECTURA</div><h2>Hola, ${escapeHtml(currentUser.name)}.</h2><p class="sub">Tu avance se sincroniza con tu cuenta.</p><p class="account-email">${escapeHtml(currentUser.email)}</p><button class="primary" id="logoutBtn">CERRAR SESIÓN</button>`);
    $('#logoutBtn').addEventListener('click', async () => {
      try { const { error } = await requireSupabase().auth.signOut(); if (error) throw error; setUser(null); closeModal(); toast('Sesión cerrada.'); }
      catch (error) { showFormError(error.message); }
    });
    return;
  }
  const signup = accountMode === 'signup';
  showModal(`<div class="eyebrow" style="justify-content:flex-start;color:#438da0">TU ESPACIO DE LECTURA</div><h2>${signup ? 'Crea tu cuenta' : 'Qué bueno verte.'}</h2><p class="sub">${signup ? 'Guarda tu avance y vuelve a tu historia cuando quieras.' : 'Entra para continuar desde tu última página.'}</p><form id="accountForm" novalidate>${signup ? '<label for="name">NOMBRE</label><input id="name" name="name" autocomplete="name" maxlength="80" placeholder="Cómo te llamamos" required>' : ''}<label for="email">CORREO ELECTRÓNICO</label><input id="email" name="email" type="email" autocomplete="email" maxlength="254" placeholder="tu@correo.com" required><label for="password">CONTRASEÑA</label><input id="password" name="password" type="password" autocomplete="${signup ? 'new-password' : 'current-password'}" minlength="12" maxlength="128" placeholder="Mínimo 12 caracteres" required>${signup ? '<label for="confirmPassword">CONFIRMA TU CONTRASEÑA</label><input id="confirmPassword" name="confirmPassword" type="password" autocomplete="new-password" minlength="12" maxlength="128" placeholder="Repite la contraseña" required>' : ''}<p class="form-error" id="formError" role="alert" aria-live="polite"></p><button class="primary">${signup ? 'CREAR CUENTA' : 'INICIAR SESIÓN'}</button></form><p class="fine-print">Las cuentas y el avance se guardan de forma segura con Supabase.</p><span class="switch" id="accountSwitch">${signup ? 'Ya tengo una cuenta · Entrar' : 'Primera vez por aquí · Crear cuenta'}</span>`);
  $('#accountSwitch').addEventListener('click', () => { accountMode = signup ? 'login' : 'signup'; accountForm(); });
  $('#accountForm').addEventListener('submit', async event => {
    event.preventDefault();
    const name = $('#name')?.value.trim();
    const email = $('#email').value.trim();
    const password = $('#password').value;
    if (signup && password !== $('#confirmPassword').value) return showFormError('Las contraseñas no coinciden.');
    const button = $('#accountForm').querySelector('button.primary');
    button.disabled = true; button.textContent = signup ? 'CREANDO CUENTA…' : 'INICIANDO SESIÓN…';
    try {
      const client = requireSupabase();
      const result = signup
        ? await client.auth.signUp({ email, password, options: { data: { display_name: name } } })
        : await client.auth.signInWithPassword({ email, password });
      if (result.error) throw result.error;
      if (signup && !result.data.session) {
        showFormError('Cuenta creada. Revisa tu correo para confirmar la dirección y luego inicia sesión.');
        button.disabled = false; button.textContent = 'CREAR CUENTA';
        return;
      }
      setUser(result.data.user);
      closeModal();
      if (signup) {
        const { error } = await client.from('reading_progress').upsert({ page_start: pageStart, updated_at: new Date().toISOString() });
        if (error) throw error;
      } else await loadUserProgress();
      toast(signup ? 'Cuenta creada. Tu avance ya está guardado.' : 'Sesión iniciada. Tu lectura está sincronizada.');
    } catch (error) {
      showFormError(error.message);
      button.disabled = false; button.textContent = signup ? 'CREAR CUENTA' : 'INICIAR SESIÓN';
    }
  });
}
function showFormError(message) {
  const error = $('#formError');
  if (error) error.textContent = message;
  else toast(message);
}
async function showComments() {
  showModal(`<div class="eyebrow" style="justify-content:flex-start;color:#438da0">CAPÍTULO ${String(chapter?.number || 1).padStart(2, '0')}</div><h2>Comentarios</h2><p class="sub">Una conversación tranquila sobre la lectura.</p><div class="comments-list">Cargando comentarios…</div>`);
  try {
    const { data: comments, error } = await requireSupabase().from('comments').select('id, body, created_at, profiles(display_name)').eq('chapter_number', chapter?.number || 1).order('created_at', { ascending: false }).limit(50);
    if (error) throw error;
    const list = comments.length ? comments.map(comment => {
      const date = new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(comment.created_at));
      return `<article class="comment-item"><div class="comment-meta"><strong>${escapeHtml(comment.profiles?.display_name || 'Lector')}</strong><time>${escapeHtml(date)}</time></div><p>${escapeHtml(comment.body)}</p></article>`;
    }).join('') : '<p class="empty-comments">Todavía no hay comentarios.</p>';
    const composer = currentUser
      ? `<form id="commentForm"><label for="commentBody">TU COMENTARIO</label><textarea id="commentBody" maxlength="2000" placeholder="¿Qué te dejó este capítulo?" required></textarea><p class="form-error" id="commentError" role="alert" aria-live="polite"></p><button class="primary">PUBLICAR COMENTARIO</button></form>`
      : `<p class="fine-print">Inicia sesión para participar en la conversación.</p><button class="primary" id="commentLogin">INICIAR SESIÓN</button>`;
    showModal(`<div class="eyebrow" style="justify-content:flex-start;color:#438da0">CAPÍTULO ${String(chapter?.number || 1).padStart(2, '0')}</div><h2>Comentarios</h2><p class="sub">Una conversación tranquila sobre la lectura.</p><div class="comments-list">${list}</div>${composer}`);
    if (currentUser) {
      $('#commentForm').addEventListener('submit', async event => {
        event.preventDefault();
        const button = $('#commentForm').querySelector('button.primary');
        button.disabled = true;
        try {
          const { error } = await requireSupabase().from('comments').insert({ chapter_number: chapter.number, body: $('#commentBody').value.trim() });
          if (error) throw error;
          await showComments();
        } catch (error) {
          $('#commentError').textContent = error.message;
          button.disabled = false;
        }
      });
    } else {
      $('#commentLogin').addEventListener('click', () => { accountMode = 'login'; accountForm(); });
    }
  } catch (error) {
    showModal(`<h2>Comentarios</h2><p class="sub">${escapeHtml(error.message)}</p>`);
  }
}function toast(message) {
  const element = $('#toast'); element.textContent = message; element.classList.add('show');
  window.setTimeout(() => element.classList.remove('show'), 2800);
}

cover.addEventListener('click', openBook);
cover.addEventListener('keydown', event => {
  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openBook(); }
});
$('#openHint').addEventListener('click', openBook);
$('#prevBtn').addEventListener('click', () => turnPage(-1));
$('#nextBtn').addEventListener('click', () => turnPage(1));
leftPage.addEventListener('click', () => turnPage(-1));
rightPage.addEventListener('click', () => turnPage(1));
$('#soundBtn').addEventListener('click', () => {
  soundOn = !soundOn;
  $('#soundBtn').classList.toggle('off', !soundOn);
  $('#soundBtn').innerHTML = soundOn ? '♫ <span>SONIDO</span>' : '♫ <span>MUDO</span>';
  $('#soundBtn').setAttribute('aria-label', soundOn ? 'Desactivar sonido' : 'Activar sonido');
});
document.addEventListener('keydown', event => {
  if (event.key === 'ArrowRight') turnPage(1);
  if (event.key === 'ArrowLeft') turnPage(-1);
  if (event.key === 'Escape') closeModal();
});
$('#accountBtn').addEventListener('click', () => { accountMode = 'signup'; accountForm(); });
$('#commentsBtn').addEventListener('click', showComments);
$('#homeBtn').addEventListener('click', event => { event.preventDefault(); returnToCover(); });
$('#modalClose').addEventListener('click', closeModal);
backdrop.addEventListener('click', event => { if (event.target === backdrop) closeModal(); });
smallScreen.addEventListener('change', () => { buildPages(); });
window.addEventListener('resize', () => {
  if (turning) return;
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => buildPages(), 120);
});

async function boot() {
  try {
    const data = await fetch('chapters.json', { cache: 'no-cache' }).then(response => {
      if (!response.ok) throw new Error('No se pudo cargar el capítulo.');
      return response.json();
    });
    chapter = data.chapters[0];
    await buildPages();
  } catch (error) { console.error(error); toast('No se pudo cargar el capítulo.'); }
  if (!sbClient) {
    console.warn('Supabase aún no está configurado. La lectura funciona, pero cuentas, progreso en la nube y comentarios requieren completar supabase-config.js.');
    return;
  }
  try {
    const { data, error } = await sbClient.auth.getUser();
    if (error) throw error;
    if (data.user) { setUser(data.user); await loadUserProgress(); }
    else setUser(null);
  } catch (error) { console.warn('Supabase no respondió:', error.message); }
}
boot();
