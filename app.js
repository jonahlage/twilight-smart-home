/* app.js — TwiLight Smart Home */

(function () {
  'use strict';

  // =============================================
  // AUTH STATE
  // =============================================
  // API_BASE: auto-detects environment
  // - Deployed (via deploy_website): __CGI_BIN__/api.py (replaced at build time)
  // - Local development: http://localhost:5000/api
  const API_BASE = (() => {
    const placeholder = '__CGI_BIN__/api.py';
    // If the placeholder was NOT replaced, we're running locally
    if (placeholder.includes('__CGI')) return 'http://localhost:5000/api';
    return placeholder;
  })();
  let authToken = null;
  let currentUser = null;

  // Default devices to create for new users
  const DEFAULT_DEVICES = [
    { name: 'Main Light', room: 'Living Room', type: 'light', is_on: true, brightness: 80, color_temp: 65, favorite: true },
    { name: 'Floor Lamp', room: 'Living Room', type: 'light', is_on: false, brightness: 50, color_temp: 50, favorite: false },
    { name: 'Smart Speaker', room: 'Living Room', type: 'speaker', is_on: true, favorite: false },
    { name: 'TV', room: 'Living Room', type: 'plug', is_on: false, power_draw: 0, favorite: false },
    { name: 'Ceiling Fan', room: 'Living Room', type: 'fan', is_on: true, speed: 'Med', favorite: false },
    { name: 'Bedroom Fan', room: 'Bedroom', type: 'fan', is_on: true, speed: 'Low', favorite: true },
    { name: 'Bedside Lamp', room: 'Bedroom', type: 'light', is_on: false, brightness: 40, color_temp: 30, favorite: false },
    { name: 'Smart Alarm', room: 'Bedroom', type: 'plug', is_on: true, power_draw: 2, favorite: false },
    { name: 'Kitchen Light', room: 'Kitchen', type: 'light', is_on: true, brightness: 100, color_temp: 80, favorite: true },
    { name: 'Coffee Maker', room: 'Kitchen', type: 'plug', is_on: false, power_draw: 0, favorite: false },
    { name: 'Dishwasher', room: 'Kitchen', type: 'plug', is_on: true, power_draw: 120, favorite: false },
    { name: 'Under-Cabinet LEDs', room: 'Kitchen', type: 'light', is_on: true, brightness: 60, color_temp: 70, favorite: false },
    { name: 'Exhaust Fan', room: 'Bathroom', type: 'fan', is_on: false, speed: 'Off', favorite: false },
    { name: 'Vanity Light', room: 'Bathroom', type: 'light', is_on: false, brightness: 70, color_temp: 60, favorite: false },
    { name: 'Thermostat', room: 'Living Room', type: 'thermostat', is_on: true, temp: 72, mode: 'Auto', favorite: true },
    { name: 'Smart Plug', room: 'Office', type: 'plug', is_on: true, power_draw: 85, favorite: true },
    { name: 'Front Door Lock', room: 'Hallway', type: 'lock', is_on: true, locked: true, favorite: true },
    { name: 'Desk Lamp', room: 'Office', type: 'light', is_on: true, brightness: 90, color_temp: 75, favorite: false },
    { name: 'Monitor', room: 'Office', type: 'plug', is_on: true, power_draw: 45, favorite: false },
    { name: 'Air Purifier', room: 'Office', type: 'fan', is_on: false, speed: 'Off', favorite: false },
  ];

  // =============================================
  // AUTH API CALLS
  // =============================================
  async function apiRequest(path, options = {}) {
    const headers = {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    };
    if (authToken) {
      headers['Authorization'] = 'Bearer ' + authToken;
    }
    try {
      const res = await fetch(API_BASE + path, {
        ...options,
        headers,
      });
      const data = await res.json();
      if (!res.ok) {
        return { ok: false, status: res.status, error: data.error || 'Request failed' };
      }
      return { ok: true, status: res.status, data };
    } catch (err) {
      return { ok: false, status: 0, error: 'Network error. Please check your connection.' };
    }
  }

  async function registerUser(email, password, displayName) {
    return apiRequest('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password, display_name: displayName }),
    });
  }

  async function loginUser(email, password) {
    return apiRequest('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
  }

  async function logoutUser() {
    return apiRequest('/auth/logout', { method: 'POST' });
  }

  async function checkSession() {
    return apiRequest('/auth/me', { method: 'GET' });
  }

  async function createDeviceAPI(device) {
    return apiRequest('/devices', {
      method: 'POST',
      body: JSON.stringify(device),
    });
  }

  async function seedDefaultDevices() {
    // Create all default devices in parallel
    const promises = DEFAULT_DEVICES.map(d => createDeviceAPI(d));
    try {
      await Promise.all(promises);
    } catch (_) {
      // Silently fail — devices can be added later
    }
  }

  // =============================================
  // AUTH UI LOGIC
  // =============================================
  function showAuthScreen() {
    const authScreen = document.getElementById('authScreen');
    const dashboard = document.getElementById('dashboardContainer');
    if (authScreen) {
      authScreen.classList.remove('hidden');
    }
    if (dashboard) {
      dashboard.style.display = 'none';
    }
  }

  function hideAuthScreen() {
    const authScreen = document.getElementById('authScreen');
    const dashboard = document.getElementById('dashboardContainer');
    if (authScreen) {
      authScreen.classList.add('hidden');
    }
    if (dashboard) {
      dashboard.style.display = '';
    }
  }

  function updateUserDisplay() {
    if (!currentUser) return;
    const nameEl = document.getElementById('sidebarUserName');
    const emailEl = document.getElementById('sidebarUserEmail');
    const avatarEl = document.getElementById('sidebarAvatar');
    const welcomeEl = document.querySelector('.welcome-text h1 span');

    const displayName = currentUser.display_name || 'User';
    if (nameEl) nameEl.textContent = displayName;
    if (emailEl) emailEl.textContent = currentUser.email || '';
    if (avatarEl) avatarEl.textContent = displayName.charAt(0).toUpperCase();
    if (welcomeEl) welcomeEl.textContent = displayName;
  }

  function showAuthError(containerId, message) {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.textContent = message;
    el.classList.add('visible');
  }

  function hideAuthError(containerId) {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.textContent = '';
    el.classList.remove('visible');
  }

  function setButtonLoading(btnId, loading) {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    if (loading) {
      btn.classList.add('loading');
      btn.disabled = true;
    } else {
      btn.classList.remove('loading');
      btn.disabled = false;
    }
  }

  // Password strength checker
  function getPasswordStrength(password) {
    if (!password || password.length < 8) return 'weak';
    const hasUpper = /[A-Z]/.test(password);
    const hasLower = /[a-z]/.test(password);
    const hasDigit = /[0-9]/.test(password);
    const hasSymbol = /[^A-Za-z0-9]/.test(password);
    const variety = [hasUpper, hasLower, hasDigit, hasSymbol].filter(Boolean).length;

    // Common weak passwords
    const common = ['password', '12345678', 'qwerty12', 'abcdefgh', 'letmein1', 'welcome1'];
    if (common.some(c => password.toLowerCase().includes(c))) return 'weak';

    if (password.length >= 12 && variety >= 3) return 'strong';
    if (password.length >= 8 && variety >= 2) return 'medium';
    return 'weak';
  }

  function updatePasswordStrength(password) {
    const container = document.getElementById('passwordStrength');
    if (!container) return;
    const fill = container.querySelector('.strength-fill');
    const label = container.querySelector('.strength-label');
    if (!fill || !label) return;

    if (!password) {
      container.classList.remove('visible');
      fill.removeAttribute('data-strength');
      label.removeAttribute('data-strength');
      label.textContent = '';
      return;
    }

    container.classList.add('visible');
    const strength = getPasswordStrength(password);
    fill.setAttribute('data-strength', strength);
    label.setAttribute('data-strength', strength);
    label.textContent = strength.charAt(0).toUpperCase() + strength.slice(1);
  }

  function initAuthUI() {
    // Tab switching
    document.querySelectorAll('.auth-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        const targetTab = tab.dataset.tab;
        document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');

        const loginForm = document.getElementById('loginForm');
        const registerForm = document.getElementById('registerForm');
        if (targetTab === 'login') {
          loginForm.style.display = '';
          registerForm.style.display = 'none';
        } else {
          loginForm.style.display = 'none';
          registerForm.style.display = '';
        }
        hideAuthError('loginError');
        hideAuthError('registerError');
      });
    });

    // Password visibility toggles
    document.querySelectorAll('.password-toggle').forEach(btn => {
      btn.addEventListener('click', () => {
        const input = btn.closest('.password-wrapper').querySelector('input');
        if (!input) return;
        const isPassword = input.type === 'password';
        input.type = isPassword ? 'text' : 'password';
        btn.classList.toggle('active', isPassword);
        btn.setAttribute('aria-label', isPassword ? 'Hide password' : 'Show password');
        // Switch icon
        if (isPassword) {
          btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
        } else {
          btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
        }
      });
    });

    // Password strength indicator
    const regPasswordInput = document.getElementById('regPassword');
    if (regPasswordInput) {
      regPasswordInput.addEventListener('input', () => {
        updatePasswordStrength(regPasswordInput.value);
      });
    }

    // Login form submit
    const loginForm = document.getElementById('loginForm');
    if (loginForm) {
      loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        hideAuthError('loginError');
        setButtonLoading('loginBtn', true);

        const email = document.getElementById('loginEmail').value.trim();
        const password = document.getElementById('loginPassword').value;

        const result = await loginUser(email, password);
        setButtonLoading('loginBtn', false);

        if (!result.ok) {
          showAuthError('loginError', result.error);
          return;
        }

        authToken = result.data.token;
        currentUser = result.data.user;
        onAuthSuccess();
      });
    }

    // Register form submit
    const registerForm = document.getElementById('registerForm');
    if (registerForm) {
      registerForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        hideAuthError('registerError');

        const displayName = document.getElementById('regName').value.trim();
        const email = document.getElementById('regEmail').value.trim();
        const password = document.getElementById('regPassword').value;
        const passwordConfirm = document.getElementById('regPasswordConfirm').value;

        // Client-side validation
        if (password.length < 8) {
          showAuthError('registerError', 'Password must be at least 8 characters.');
          return;
        }
        if (password !== passwordConfirm) {
          showAuthError('registerError', 'Passwords do not match.');
          return;
        }

        setButtonLoading('registerBtn', true);

        const result = await registerUser(email, password, displayName);
        setButtonLoading('registerBtn', false);

        if (!result.ok) {
          showAuthError('registerError', result.error);
          return;
        }

        authToken = result.data.token;
        currentUser = result.data.user;

        // Seed default devices for new user (non-blocking)
        seedDefaultDevices();

        onAuthSuccess();
      });
    }

    // Sign out button
    const signOutBtn = document.getElementById('signOutBtn');
    if (signOutBtn) {
      signOutBtn.addEventListener('click', async () => {
        await logoutUser();
        authToken = null;
        currentUser = null;
        showAuthScreen();
        // Reset forms
        const loginFormEl = document.getElementById('loginForm');
        const registerFormEl = document.getElementById('registerForm');
        if (loginFormEl) loginFormEl.reset();
        if (registerFormEl) registerFormEl.reset();
        hideAuthError('loginError');
        hideAuthError('registerError');
        updatePasswordStrength('');
        // Reset tab to login
        document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
        const loginTab = document.querySelector('.auth-tab[data-tab="login"]');
        if (loginTab) loginTab.classList.add('active');
        if (loginFormEl) loginFormEl.style.display = '';
        if (registerFormEl) registerFormEl.style.display = 'none';
      });
    }
  }

  function onAuthSuccess() {
    updateUserDisplay();
    hideAuthScreen();
    // Kick off dashboard
    initDashboard();
  }

  // =============================================
  // STATE
  // =============================================
  const state = {
    currentView: 'dashboard',
    theme: 'dark',
    searchQuery: '',
    activeFilter: 'all',
    energyPeriod: 'daily',
    devices: [
      { id: 1, name: 'Main Light', room: 'Living Room', type: 'light', on: true, brightness: 80, colorTemp: 65, favorite: true },
      { id: 2, name: 'Floor Lamp', room: 'Living Room', type: 'light', on: false, brightness: 50, colorTemp: 50, favorite: false },
      { id: 3, name: 'Smart Speaker', room: 'Living Room', type: 'speaker', on: true, favorite: false },
      { id: 4, name: 'TV', room: 'Living Room', type: 'plug', on: false, powerDraw: 0, favorite: false },
      { id: 5, name: 'Ceiling Fan', room: 'Living Room', type: 'fan', on: true, speed: 'Med', favorite: false },
      { id: 6, name: 'Bedroom Fan', room: 'Bedroom', type: 'fan', on: true, speed: 'Low', favorite: true },
      { id: 7, name: 'Bedside Lamp', room: 'Bedroom', type: 'light', on: false, brightness: 40, colorTemp: 30, favorite: false },
      { id: 8, name: 'Smart Alarm', room: 'Bedroom', type: 'plug', on: true, powerDraw: 2, favorite: false },
      { id: 9, name: 'Kitchen Light', room: 'Kitchen', type: 'light', on: true, brightness: 100, colorTemp: 80, favorite: true },
      { id: 10, name: 'Coffee Maker', room: 'Kitchen', type: 'plug', on: false, powerDraw: 0, favorite: false },
      { id: 11, name: 'Dishwasher', room: 'Kitchen', type: 'plug', on: true, powerDraw: 120, favorite: false },
      { id: 12, name: 'Under-Cabinet LEDs', room: 'Kitchen', type: 'light', on: true, brightness: 60, colorTemp: 70, favorite: false },
      { id: 13, name: 'Exhaust Fan', room: 'Bathroom', type: 'fan', on: false, speed: 'Off', favorite: false },
      { id: 14, name: 'Vanity Light', room: 'Bathroom', type: 'light', on: false, brightness: 70, colorTemp: 60, favorite: false },
      { id: 15, name: 'Thermostat', room: 'Living Room', type: 'thermostat', on: true, temp: 72, mode: 'Auto', favorite: true },
      { id: 16, name: 'Smart Plug', room: 'Office', type: 'plug', on: true, powerDraw: 85, favorite: true },
      { id: 17, name: 'Front Door Lock', room: 'Hallway', type: 'lock', on: true, locked: true, favorite: true },
      { id: 18, name: 'Desk Lamp', room: 'Office', type: 'light', on: true, brightness: 90, colorTemp: 75, favorite: false },
      { id: 19, name: 'Monitor', room: 'Office', type: 'plug', on: true, powerDraw: 45, favorite: false },
      { id: 20, name: 'Air Purifier', room: 'Office', type: 'fan', on: false, speed: 'Off', favorite: false },
    ],
    rooms: [
      { name: 'Living Room', icon: 'sofa' },
      { name: 'Bedroom', icon: 'bed' },
      { name: 'Kitchen', icon: 'kitchen' },
      { name: 'Bathroom', icon: 'bath' },
      { name: 'Office', icon: 'office' },
      { name: 'Hallway', icon: 'door' },
    ],
    scenes: [
      { id: 1, name: 'Movie Night', emoji: '🎬', desc: 'Dims lights, closes blinds', actions: [
        { deviceId: 1, set: { on: true, brightness: 20 } },
        { deviceId: 2, set: { on: false } },
        { deviceId: 9, set: { on: false } },
        { deviceId: 18, set: { on: false } },
      ]},
      { id: 2, name: 'Good Morning', emoji: '☀️', desc: 'Lights on, coffee maker on', actions: [
        { deviceId: 1, set: { on: true, brightness: 100 } },
        { deviceId: 9, set: { on: true, brightness: 100 } },
        { deviceId: 10, set: { on: true } },
        { deviceId: 14, set: { on: true, brightness: 80 } },
      ]},
      { id: 3, name: 'Away Mode', emoji: '🔒', desc: 'All off, locks engaged', actions: [
        { deviceId: 1, set: { on: false } },
        { deviceId: 2, set: { on: false } },
        { deviceId: 9, set: { on: false } },
        { deviceId: 12, set: { on: false } },
        { deviceId: 18, set: { on: false } },
        { deviceId: 17, set: { locked: true } },
      ]},
      { id: 4, name: 'Bedtime', emoji: '🌙', desc: 'Lights off, fan on low', actions: [
        { deviceId: 1, set: { on: false } },
        { deviceId: 9, set: { on: false } },
        { deviceId: 12, set: { on: false } },
        { deviceId: 18, set: { on: false } },
        { deviceId: 6, set: { on: true, speed: 'Low' } },
      ]},
    ],
    automations: [
      { id: 1, name: 'Sunset Porch Lights', trigger: 'If sunset → Turn on porch lights', icon: 'sunset', enabled: true },
      { id: 2, name: 'Temperature Guard', trigger: 'If temp > 78°F → Turn on AC', icon: 'thermometer', enabled: true },
      { id: 3, name: 'Morning Routine', trigger: 'At 7:00 AM → Run "Good Morning" scene', icon: 'clock', enabled: true },
      { id: 4, name: 'Motion Night Light', trigger: 'If motion detected at night → Dim hallway light', icon: 'motion', enabled: false },
      { id: 5, name: 'Away Lock', trigger: 'If no motion for 30 min → Lock all doors', icon: 'lock', enabled: true },
      { id: 6, name: 'Energy Saver', trigger: 'If energy > 5 kWh → Notify and dim lights 20%', icon: 'energy', enabled: true },
    ],
    energyData: {
      daily: {
        labels: ['12am','3am','6am','9am','12pm','3pm','6pm','9pm'],
        data: [0.3, 0.2, 0.8, 1.5, 2.1, 2.4, 1.8, 1.2],
      },
      weekly: {
        labels: ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'],
        data: [14.2, 12.8, 15.1, 13.5, 16.2, 18.4, 11.8],
      },
      monthly: {
        labels: ['Week 1','Week 2','Week 3','Week 4'],
        data: [92, 88, 102, 78],
      },
    },
  };

  // =============================================
  // ICONS
  // =============================================
  const icons = {
    bulb: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z"/></svg>',
    fan: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 12c-1.5-4.5-5-7-8-6s-3 5 0 8c-4.5 1.5-7 5-6 8s5 3 8 0c1.5 4.5 5 7 8 6s3-5 0-8c4.5-1.5 7-5 6-8s-5-3-8 0z"/><circle cx="12" cy="12" r="2"/></svg>',
    thermo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 14.76V3.5a2.5 2.5 0 0 0-5 0v11.26a4.5 4.5 0 1 0 5 0z"/></svg>',
    plug: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a6 6 0 0 1-12 0V8z"/></svg>',
    lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
    unlock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>',
    speaker: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>',
    sofa: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v3"/><path d="M2 11v5a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-5a2 2 0 0 0-4 0v2H6v-2a2 2 0 0 0-4 0z"/><path d="M4 18v2"/><path d="M20 18v2"/></svg>',
    bed: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4v16"/><path d="M2 8h18a2 2 0 0 1 2 2v10"/><path d="M2 17h20"/><path d="M6 8v9"/></svg>',
    kitchen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2"/><path d="M7 2v20"/><path d="M21 15V2v0a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3"/><path d="M18 15v7"/></svg>',
    bath: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12h16a1 1 0 0 1 1 1v3a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4v-3a1 1 0 0 1 1-1z"/><path d="M6 12V5a2 2 0 0 1 2-2h3"/><path d="M4 21v-1"/><path d="M20 21v-1"/></svg>',
    office: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/></svg>',
    door: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 20V6a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v14"/><path d="M2 20h20"/><path d="M14 12v.01"/></svg>',
    sunset: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 18a5 5 0 0 0-10 0"/><line x1="12" y1="9" x2="12" y2="2"/><line x1="4.22" y1="10.22" x2="5.64" y2="11.64"/><line x1="1" y1="18" x2="3" y2="18"/><line x1="21" y1="18" x2="23" y2="18"/><line x1="18.36" y1="11.64" x2="19.78" y2="10.22"/><line x1="23" y1="22" x2="1" y2="22"/><polyline points="16 5 12 9 8 5"/></svg>',
    thermometer: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 14.76V3.5a2.5 2.5 0 0 0-5 0v11.26a4.5 4.5 0 1 0 5 0z"/></svg>',
    clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
    motion: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>',
    energy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10"/></svg>',
  };

  function getDeviceIcon(type) {
    const map = { light: 'bulb', fan: 'fan', thermostat: 'thermo', plug: 'plug', lock: 'lock', speaker: 'speaker' };
    return icons[map[type] || 'plug'] || icons.plug;
  }

  function getRoomIcon(iconName) {
    return icons[iconName] || icons.sofa;
  }

  // =============================================
  // THEME
  // =============================================
  function initTheme() {
    // Default to dark for this app
    state.theme = 'dark';
    document.documentElement.setAttribute('data-theme', 'dark');
    updateThemeIcon();
  }

  window.toggleTheme = function () {
    state.theme = state.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', state.theme);
    updateThemeIcon();
    // Re-render chart if on energy view
    if (state.currentView === 'energy') {
      renderEnergyChart();
    }
  };

  function updateThemeIcon() {
    const btn = document.getElementById('themeToggle');
    if (!btn) return;
    btn.innerHTML = state.theme === 'dark'
      ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>'
      : '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
    btn.setAttribute('aria-label', `Switch to ${state.theme === 'dark' ? 'light' : 'dark'} mode`);
  }

  // =============================================
  // SIDEBAR (mobile)
  // =============================================
  window.toggleSidebar = function () {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebarOverlay');
    sidebar.classList.toggle('open');
    overlay.classList.toggle('open');
  };

  window.closeSidebar = function () {
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('sidebarOverlay').classList.remove('open');
  };

  // =============================================
  // ROUTING
  // =============================================
  // =============================================
  // SMART DEVICE STATE
  // =============================================
  let smartProviders = [];
  let smartDevices = [];
  let deviceSourceTab = 'local'; // 'local' or 'smart'
  let connectModalProvider = null;

  const viewTitles = {
    dashboard: 'Dashboard',
    rooms: 'Rooms',
    devices: 'Devices',
    scenes: 'Scenes',
    automations: 'Automations',
    energy: 'Energy',
    settings: 'Settings',
  };

  function navigateTo(view) {
    if (!viewTitles[view]) view = 'dashboard';
    state.currentView = view;

    // Update nav active state
    document.querySelectorAll('.nav-item').forEach(item => {
      item.classList.toggle('active', item.dataset.view === view);
    });

    // Update header title
    document.getElementById('headerTitle').textContent = viewTitles[view];

    // Show correct view
    document.querySelectorAll('.view').forEach(v => {
      v.classList.remove('active');
      v.style.display = 'none';
    });
    const activeView = document.getElementById('view-' + view);
    if (activeView) {
      activeView.style.display = 'block';
      // Trigger animation
      activeView.classList.remove('active');
      void activeView.offsetWidth; // force reflow
      activeView.classList.add('active');
    }

    // Close sidebar on mobile
    closeSidebar();

    // Scroll main to top
    document.querySelector('.main').scrollTop = 0;

    // Render view-specific content
    renderView(view);
  }

  function renderView(view) {
    switch (view) {
      case 'dashboard': renderDashboard(); break;
      case 'rooms': renderRoomsView(); break;
      case 'devices': renderDevicesView(); break;
      case 'scenes': renderScenesView(); break;
      case 'automations': renderAutomationsView(); break;
      case 'energy': renderEnergyView(); break;
      case 'settings': renderSettingsView(); break;
    }
  }

  // Hash routing
  function handleHash() {
    const hash = window.location.hash.slice(1) || 'dashboard';
    navigateTo(hash);
  }

  window.addEventListener('hashchange', handleHash);

  // Nav item clicks
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      const view = item.dataset.view;
      window.location.hash = '#' + view;
    });
  });

  // =============================================
  // RENDER: DASHBOARD
  // =============================================
  function renderDashboard() {
    renderFavoriteDevices();
    renderRoomsScroll();
    renderScenesGrid();
    updateKPIs();
    renderSparkline();
  }

  function updateKPIs() {
    const active = state.devices.filter(d => d.on).length;
    const total = state.devices.length;
    document.getElementById('kpiActiveDevices').textContent = `${active}/${total}`;

    const lightsOn = state.devices.filter(d => d.type === 'light' && d.on).length;
    const lightsOnEl = document.getElementById('lightsOnCount');
    if (lightsOnEl) lightsOnEl.textContent = lightsOn;
  }

  function renderSparkline() {
    const canvas = document.getElementById('sparklineEnergy');
    if (!canvas || typeof Chart === 'undefined') return;
    const ctx = canvas.getContext('2d');

    // Destroy existing chart if any
    if (canvas._chart) canvas._chart.destroy();

    const accentColor = getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim();

    canvas._chart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: state.energyData.daily.labels,
        datasets: [{
          data: state.energyData.daily.data,
          borderColor: accentColor || '#d4a050',
          backgroundColor: (accentColor || '#d4a050') + '22',
          borderWidth: 2,
          fill: true,
          tension: 0.4,
          pointRadius: 0,
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { enabled: false } },
        scales: { x: { display: false }, y: { display: false } },
        animation: { duration: 600, easing: 'easeOutQuart' },
      }
    });
  }

  // =============================================
  // RENDER: FAVORITE DEVICES
  // =============================================
  function renderFavoriteDevices() {
    const container = document.getElementById('favoriteDevices');
    if (!container) return;
    const favs = state.devices.filter(d => d.favorite);
    container.innerHTML = favs.map(d => renderDeviceCard(d)).join('');
    attachDeviceListeners(container);
  }

  function renderDeviceCard(d) {
    const onClass = d.on ? ' on' : '';
    let controls = '';

    if (d.type === 'light') {
      controls = `
        <div class="device-controls">
          <div class="slider-control">
            <label>Brightness</label>
            <input type="range" min="0" max="100" value="${d.brightness || 0}" data-device="${d.id}" data-prop="brightness" aria-label="Brightness">
            <span class="slider-value">${d.brightness || 0}%</span>
          </div>
        </div>`;
    } else if (d.type === 'fan') {
      const speeds = ['Low', 'Med', 'High'];
      controls = `
        <div class="device-controls">
          <div class="speed-selector">
            ${speeds.map(s => `<button class="speed-btn${d.speed === s ? ' active' : ''}" data-device="${d.id}" data-speed="${s}">${s}</button>`).join('')}
          </div>
        </div>`;
    } else if (d.type === 'thermostat') {
      const modes = ['Heat', 'Cool', 'Auto'];
      controls = `
        <div class="device-controls">
          <div class="thermostat-control">
            <button class="temp-btn" data-device="${d.id}" data-temp-dir="down" aria-label="Decrease temperature">−</button>
            <div class="temp-display">${d.temp}°F</div>
            <button class="temp-btn" data-device="${d.id}" data-temp-dir="up" aria-label="Increase temperature">+</button>
          </div>
          <div class="mode-selector">
            ${modes.map(m => `<button class="mode-btn${d.mode === m ? ' active' : ''}" data-device="${d.id}" data-mode="${m}">${m}</button>`).join('')}
          </div>
        </div>`;
    } else if (d.type === 'plug') {
      controls = `
        <div class="power-draw">
          ${icons.energy}
          <span>${d.on ? (d.powerDraw || 0) + 'W' : '0W'}</span>
        </div>`;
    } else if (d.type === 'lock') {
      const locked = d.locked !== false;
      controls = `
        <div class="lock-status ${locked ? 'locked' : 'unlocked'}">
          ${locked ? icons.lock : icons.unlock}
          <span>${locked ? 'Locked' : 'Unlocked'}</span>
        </div>`;
    }

    const statusText = getStatusText(d);

    return `
      <div class="device-card${onClass}" data-device-id="${d.id}">
        <div class="device-card-header">
          <div class="device-icon">${getDeviceIcon(d.type)}</div>
          <div class="toggle-switch${d.on ? ' on' : ''}" data-toggle="${d.id}" role="switch" aria-checked="${d.on}" aria-label="Toggle ${d.name}" tabindex="0"></div>
        </div>
        <div class="device-name">${d.name}</div>
        <div class="device-room">${d.room}</div>
        <div class="device-status">${statusText}</div>
        ${controls}
      </div>`;
  }

  function getStatusText(d) {
    if (!d.on) return 'Off';
    switch (d.type) {
      case 'light': return `On · ${d.brightness}%`;
      case 'fan': return `On · ${d.speed}`;
      case 'thermostat': return `${d.temp}°F · ${d.mode}`;
      case 'plug': return `On · ${d.powerDraw || 0}W`;
      case 'lock': return d.locked !== false ? 'Locked' : 'Unlocked';
      case 'speaker': return 'Playing';
      default: return 'On';
    }
  }

  function attachDeviceListeners(container) {
    // Toggle switches
    container.querySelectorAll('.toggle-switch[data-toggle]').forEach(toggle => {
      toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = parseInt(toggle.dataset.toggle);
        const device = state.devices.find(d => d.id === id);
        if (device) {
          device.on = !device.on;
          refreshAllViews();
        }
      });
      toggle.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggle.click();
        }
      });
    });

    // Brightness sliders
    container.querySelectorAll('input[type="range"][data-prop="brightness"]').forEach(slider => {
      slider.addEventListener('input', (e) => {
        const id = parseInt(slider.dataset.device);
        const device = state.devices.find(d => d.id === id);
        if (device) {
          device.brightness = parseInt(e.target.value);
          const valueEl = slider.parentElement.querySelector('.slider-value');
          if (valueEl) valueEl.textContent = device.brightness + '%';
          // Update status text
          const card = slider.closest('.device-card');
          if (card) {
            const statusEl = card.querySelector('.device-status');
            if (statusEl) statusEl.textContent = getStatusText(device);
          }
        }
      });
    });

    // Speed buttons
    container.querySelectorAll('.speed-btn[data-speed]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = parseInt(btn.dataset.device);
        const speed = btn.dataset.speed;
        const device = state.devices.find(d => d.id === id);
        if (device) {
          device.speed = speed;
          refreshAllViews();
        }
      });
    });

    // Temp buttons
    container.querySelectorAll('.temp-btn[data-temp-dir]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = parseInt(btn.dataset.device);
        const dir = btn.dataset.tempDir;
        const device = state.devices.find(d => d.id === id);
        if (device) {
          device.temp = dir === 'up' ? device.temp + 1 : device.temp - 1;
          refreshAllViews();
        }
      });
    });

    // Mode buttons
    container.querySelectorAll('.mode-btn[data-mode]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = parseInt(btn.dataset.device);
        const mode = btn.dataset.mode;
        const device = state.devices.find(d => d.id === id);
        if (device) {
          device.mode = mode;
          refreshAllViews();
        }
      });
    });

    // Lock toggle via lock-status click
    container.querySelectorAll('.lock-status').forEach(lockEl => {
      lockEl.addEventListener('click', (e) => {
        e.stopPropagation();
        const card = lockEl.closest('.device-card');
        if (!card) return;
        const id = parseInt(card.dataset.deviceId);
        const device = state.devices.find(d => d.id === id);
        if (device && device.type === 'lock') {
          device.locked = !device.locked;
          refreshAllViews();
        }
      });
      lockEl.style.cursor = 'pointer';
    });
  }

  function refreshAllViews() {
    // Refresh current view content
    renderView(state.currentView);
    updateKPIs();
  }

  // =============================================
  // RENDER: ROOMS SCROLL (dashboard)
  // =============================================
  function renderRoomsScroll() {
    const container = document.getElementById('roomsScroll');
    if (!container) return;
    container.innerHTML = state.rooms.map(room => {
      const devicesInRoom = state.devices.filter(d => d.room === room.name);
      const activeCount = devicesInRoom.filter(d => d.on).length;
      return `
        <div class="room-card" onclick="window.location.hash='#rooms'" tabindex="0" role="button" aria-label="${room.name}: ${devicesInRoom.length} devices, ${activeCount} active">
          <div class="room-card-icon">${getRoomIcon(room.icon)}</div>
          <div class="room-card-name">${room.name}</div>
          <div class="room-card-meta">${devicesInRoom.length} devices · <span class="active-count">${activeCount} active</span></div>
        </div>`;
    }).join('');
  }

  // =============================================
  // RENDER: SCENES GRID (dashboard)
  // =============================================
  function renderScenesGrid() {
    const container = document.getElementById('scenesGrid');
    if (!container) return;
    container.innerHTML = state.scenes.map(scene => `
      <div class="scene-card" data-scene="${scene.id}" tabindex="0" role="button" aria-label="Activate ${scene.name}">
        <div class="scene-icon">${scene.emoji}</div>
        <div class="scene-name">${scene.name}</div>
        <div class="scene-desc">${scene.desc}</div>
      </div>`
    ).join('');

    container.querySelectorAll('.scene-card').forEach(card => {
      card.addEventListener('click', () => activateScene(parseInt(card.dataset.scene)));
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          activateScene(parseInt(card.dataset.scene));
        }
      });
    });
  }

  function activateScene(sceneId) {
    const scene = state.scenes.find(s => s.id === sceneId);
    if (!scene) return;

    // Animate scene card
    const card = document.querySelector(`.scene-card[data-scene="${sceneId}"]`);
    if (card) {
      card.classList.add('activating');
      setTimeout(() => card.classList.remove('activating'), 800);
    }

    // Apply scene actions
    scene.actions.forEach(action => {
      const device = state.devices.find(d => d.id === action.deviceId);
      if (device) {
        Object.assign(device, action.set);
      }
    });

    // Refresh
    setTimeout(() => refreshAllViews(), 300);
  }

  // =============================================
  // RENDER: ROOMS VIEW
  // =============================================
  function renderRoomsView() {
    const container = document.getElementById('roomsViewGrid');
    if (!container) return;
    container.innerHTML = state.rooms.map(room => {
      const devicesInRoom = state.devices.filter(d => d.room === room.name);
      const activeCount = devicesInRoom.filter(d => d.on).length;
      return `
        <div class="room-detail-card" tabindex="0">
          <div class="room-detail-header">
            <div class="room-detail-icon">${getRoomIcon(room.icon)}</div>
            <div>
              <div class="room-detail-name">${room.name}</div>
              <div class="room-detail-count">${devicesInRoom.length} devices · ${activeCount} active</div>
            </div>
          </div>
          <div class="room-devices-list">
            ${devicesInRoom.map(d => `
              <div class="room-device-item">
                <div class="device-mini-name">
                  ${getDeviceIcon(d.type)}
                  ${d.name}
                </div>
                <div class="status-dot${d.on ? ' on' : ''}"></div>
              </div>
            `).join('')}
          </div>
        </div>`;
    }).join('');
  }

  // =============================================
  // RENDER: DEVICES VIEW
  // =============================================
  function renderDevicesView() {
    initDeviceSourceTabs();
    if (deviceSourceTab === 'local') {
      renderFilterBar();
      renderAllDevices();
    } else {
      renderSmartDevicesGrid();
    }
  }

  function initDeviceSourceTabs() {
    const tabs = document.querySelectorAll('.device-source-tab');
    const localSection = document.getElementById('localDevicesSection');
    const smartSection = document.getElementById('smartDevicesSection');

    tabs.forEach(tab => {
      tab.classList.toggle('active', tab.dataset.source === deviceSourceTab);
      tab.onclick = () => {
        deviceSourceTab = tab.dataset.source;
        tabs.forEach(t => t.classList.toggle('active', t.dataset.source === deviceSourceTab));
        if (deviceSourceTab === 'local') {
          localSection.style.display = '';
          smartSection.style.display = 'none';
          renderFilterBar();
          renderAllDevices();
        } else {
          localSection.style.display = 'none';
          smartSection.style.display = '';
          loadSmartDevices();
        }
      };
    });

    // Show correct section
    if (localSection && smartSection) {
      localSection.style.display = deviceSourceTab === 'local' ? '' : 'none';
      smartSection.style.display = deviceSourceTab === 'smart' ? '' : 'none';
    }
  }

  function renderFilterBar() {
    const container = document.getElementById('filterBar');
    if (!container) return;
    const types = ['all', 'light', 'fan', 'thermostat', 'plug', 'lock', 'speaker'];
    const labels = { all: 'All', light: 'Lights', fan: 'Fans', thermostat: 'Thermostat', plug: 'Plugs', lock: 'Locks', speaker: 'Speakers' };

    // Room filters
    const rooms = ['all', ...state.rooms.map(r => r.name)];

    container.innerHTML = types.map(t =>
      `<button class="filter-btn${state.activeFilter === t ? ' active' : ''}" data-filter="${t}">${labels[t] || t}</button>`
    ).join('');

    container.querySelectorAll('.filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        state.activeFilter = btn.dataset.filter;
        renderDevicesView();
      });
    });
  }

  function renderAllDevices() {
    const container = document.getElementById('allDevicesGrid');
    if (!container) return;

    let filtered = state.devices;
    if (state.activeFilter !== 'all') {
      filtered = filtered.filter(d => d.type === state.activeFilter);
    }
    if (state.searchQuery) {
      const q = state.searchQuery.toLowerCase();
      filtered = filtered.filter(d =>
        d.name.toLowerCase().includes(q) || d.room.toLowerCase().includes(q)
      );
    }

    container.innerHTML = filtered.map(d => renderDeviceCard(d)).join('');
    attachDeviceListeners(container);
  }

  // =============================================
  // RENDER: SCENES VIEW
  // =============================================
  function renderScenesView() {
    const container = document.getElementById('scenesViewGrid');
    if (!container) return;
    container.innerHTML = state.scenes.map(scene => {
      const deviceNames = scene.actions.map(a => {
        const dev = state.devices.find(d => d.id === a.deviceId);
        return dev ? `${dev.name}: ${Object.entries(a.set).map(([k,v]) => `${k}=${v}`).join(', ')}` : '';
      }).filter(Boolean);

      return `
        <div class="scene-detail-card" tabindex="0">
          <div class="scene-detail-header">
            <span class="scene-detail-emoji">${scene.emoji}</span>
            <span class="scene-detail-name">${scene.name}</span>
          </div>
          <div class="scene-detail-desc">${scene.desc}</div>
          <div class="scene-devices-list">
            ${deviceNames.map(n => `<div class="scene-device-item">· ${n}</div>`).join('')}
          </div>
          <button class="scene-activate-btn" data-scene="${scene.id}">Activate</button>
        </div>`;
    }).join('');

    container.querySelectorAll('.scene-activate-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        activateScene(parseInt(btn.dataset.scene));
      });
    });
  }

  // =============================================
  // RENDER: AUTOMATIONS VIEW
  // =============================================
  function renderAutomationsView() {
    const container = document.getElementById('automationList');
    if (!container) return;
    container.innerHTML = state.automations.map(auto => `
      <div class="automation-card">
        <div class="automation-icon">${icons[auto.icon] || icons.energy}</div>
        <div class="automation-info">
          <div class="automation-name">${auto.name}</div>
          <div class="automation-trigger">${auto.trigger}</div>
        </div>
        <div class="toggle-switch${auto.enabled ? ' on' : ''}" data-automation="${auto.id}" role="switch" aria-checked="${auto.enabled}" aria-label="Toggle ${auto.name}" tabindex="0"></div>
      </div>`
    ).join('');

    container.querySelectorAll('.toggle-switch[data-automation]').forEach(toggle => {
      toggle.addEventListener('click', () => {
        const id = parseInt(toggle.dataset.automation);
        const auto = state.automations.find(a => a.id === id);
        if (auto) {
          auto.enabled = !auto.enabled;
          renderAutomationsView();
        }
      });
      toggle.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggle.click();
        }
      });
    });
  }

  // =============================================
  // RENDER: ENERGY VIEW
  // =============================================
  let energyChartInstance = null;

  function renderEnergyView() {
    renderEnergyChart();
    renderEnergyBreakdown();
    attachChartTabs();
  }

  function renderEnergyChart() {
    if (typeof Chart === 'undefined') return;
    const canvas = document.getElementById('energyChart');
    if (!canvas) return;

    if (energyChartInstance) energyChartInstance.destroy();

    const period = state.energyPeriod;
    const data = state.energyData[period];
    const isDark = state.theme === 'dark';

    const accentColor = getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim() || '#d4a050';
    const textMuted = getComputedStyle(document.documentElement).getPropertyValue('--color-text-muted').trim() || '#888';
    const divider = getComputedStyle(document.documentElement).getPropertyValue('--color-divider').trim() || '#333';

    energyChartInstance = new Chart(canvas.getContext('2d'), {
      type: 'bar',
      data: {
        labels: data.labels,
        datasets: [{
          label: period === 'daily' ? 'kWh' : period === 'weekly' ? 'kWh' : 'kWh',
          data: data.data,
          backgroundColor: accentColor + (isDark ? '99' : '88'),
          borderColor: accentColor,
          borderWidth: 1,
          borderRadius: 6,
          borderSkipped: false,
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: isDark ? 'rgba(30,30,40,0.95)' : 'rgba(255,255,255,0.95)',
            titleColor: isDark ? '#fff' : '#222',
            bodyColor: isDark ? '#ccc' : '#555',
            borderColor: divider,
            borderWidth: 1,
            cornerRadius: 8,
            padding: 12,
          },
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: { color: textMuted, font: { family: "'DM Sans'" } },
          },
          y: {
            grid: { color: divider + '44' },
            ticks: { color: textMuted, font: { family: "'DM Sans'" } },
            beginAtZero: true,
          },
        },
        animation: { duration: 600, easing: 'easeOutQuart' },
      }
    });
  }

  function attachChartTabs() {
    document.querySelectorAll('.chart-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        state.energyPeriod = tab.dataset.period;
        document.querySelectorAll('.chart-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        renderEnergyChart();
      });
    });
  }

  function renderEnergyBreakdown() {
    const container = document.getElementById('energyBreakdown');
    if (!container) return;

    const breakdown = [
      { name: 'Lighting', kwh: '0.8 kWh', cost: '$0.52', icon: 'bulb' },
      { name: 'HVAC', kwh: '0.9 kWh', cost: '$0.59', icon: 'thermo' },
      { name: 'Kitchen', kwh: '0.4 kWh', cost: '$0.26', icon: 'kitchen' },
      { name: 'Office', kwh: '0.2 kWh', cost: '$0.13', icon: 'office' },
      { name: 'Entertainment', kwh: '0.05 kWh', cost: '$0.03', icon: 'speaker' },
      { name: 'Other', kwh: '0.05 kWh', cost: '$0.03', icon: 'plug' },
    ];

    container.innerHTML = breakdown.map(b => `
      <div class="breakdown-item">
        <div class="b-icon">${icons[b.icon] || icons.plug}</div>
        <div class="b-info">
          <div class="b-name">${b.name}</div>
          <div class="b-kwh">${b.kwh}</div>
        </div>
        <div class="b-cost">${b.cost}</div>
      </div>`
    ).join('');
  }

  // =============================================
  // SEARCH
  // =============================================

  // =============================================
  // SMART DEVICE API CALLS
  // =============================================

  async function loadSmartProviders() {
    const result = await apiRequest('/smart/providers', { method: 'GET' });
    if (result.ok && result.data && result.data.providers) {
      smartProviders = result.data.providers;
    } else {
      // Fallback: show providers from local config even if API fails
      smartProviders = [
        { id: 'govee', name: 'Govee', description: 'Smart LED lights, strips, and home devices', key_label: 'Govee API Key', key_hint: 'Find at https://developer.govee.com — free tier available', connected: false },
        { id: 'lifx', name: 'LIFX', description: 'Smart WiFi light bulbs and strips', key_label: 'LIFX Personal Access Token', key_hint: 'Generate at https://cloud.lifx.com/settings', connected: false },
      ];
    }
    return smartProviders;
  }

  async function connectProvider(provider, apiKey) {
    return apiRequest('/smart/connect', {
      method: 'POST',
      body: JSON.stringify({ provider, api_key: apiKey }),
    });
  }

  async function disconnectProvider(provider) {
    return apiRequest('/smart/disconnect', {
      method: 'POST',
      body: JSON.stringify({ provider }),
    });
  }

  async function loadSmartDevices() {
    const result = await apiRequest('/smart/devices', { method: 'GET' });
    if (result.ok) {
      smartDevices = result.data.devices || [];
    }
    renderSmartDevicesGrid();
    return smartDevices;
  }

  async function syncSmartDevices(provider) {
    const body = provider ? { provider } : {};
    const result = await apiRequest('/smart/sync', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    if (result.ok) {
      smartDevices = result.data.devices || [];
      showToast(result.data.message || 'Devices synced', 'success');
    } else {
      showToast(result.error || 'Sync failed', 'error');
    }
    renderSmartDevicesGrid();
    return result;
  }

  async function controlSmartDevice(deviceId, action, value) {
    const payload = { device_id: deviceId, action };
    if (value !== undefined) payload.value = value;
    const result = await apiRequest('/smart/control', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    if (result.ok && result.data.device) {
      // Update local state
      const idx = smartDevices.findIndex(d => d.id === deviceId);
      if (idx >= 0) smartDevices[idx] = result.data.device;
      renderSmartDevicesGrid();
    } else {
      showToast(result.error || result.data?.api_response?.error || 'Control failed', 'error');
    }
    return result;
  }

  // =============================================
  // TOAST NOTIFICATIONS
  // =============================================
  function showToast(message, type) {
    let toast = document.querySelector('.toast-notification');
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'toast-notification';
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.className = 'toast-notification ' + (type || '');
    // Force reflow
    void toast.offsetWidth;
    toast.classList.add('show');
    clearTimeout(toast._timeout);
    toast._timeout = setTimeout(() => {
      toast.classList.remove('show');
    }, 3000);
  }

  // =============================================
  // RENDER: SMART DEVICES GRID
  // =============================================
  function renderSmartDevicesGrid() {
    const grid = document.getElementById('smartDevicesGrid');
    const empty = document.getElementById('smartDevicesEmpty');
    const countEl = document.getElementById('smartDevicesCount');

    if (!grid) return;

    if (smartDevices.length === 0) {
      grid.innerHTML = '';
      if (empty) empty.style.display = '';
      if (countEl) countEl.textContent = '0 devices';
      return;
    }

    if (empty) empty.style.display = 'none';
    if (countEl) countEl.textContent = `${smartDevices.length} device${smartDevices.length !== 1 ? 's' : ''}`;

    grid.innerHTML = smartDevices.map(d => renderSmartDeviceCard(d)).join('');
    attachSmartDeviceListeners(grid);
  }

  function renderSmartDeviceCard(d) {
    const onClass = d.is_on ? ' on' : '';
    const onlineClass = d.is_online ? '' : ' offline';
    const providerLabel = d.provider.charAt(0).toUpperCase() + d.provider.slice(1);

    let controls = '';
    if (d.type === 'light') {
      controls = `
        <div class="device-controls">
          <div class="slider-control">
            <label>Brightness</label>
            <input type="range" min="0" max="100" value="${d.brightness || 0}" data-smart-device="${d.id}" data-smart-prop="brightness" aria-label="Brightness">
            <span class="slider-value">${d.brightness || 0}%</span>
          </div>
        </div>`;
    }

    const statusText = !d.is_online ? 'Offline' : (d.is_on ? `On · ${d.brightness}%` : 'Off');

    return `
      <div class="device-card${onClass}${onlineClass}" data-smart-device-id="${d.id}">
        <div class="device-card-header">
          <div class="device-icon">${getDeviceIcon(d.type)}</div>
          <div class="toggle-switch${d.is_on ? ' on' : ''}" data-smart-toggle="${d.id}" role="switch" aria-checked="${d.is_on}" aria-label="Toggle ${d.name}" tabindex="0"></div>
        </div>
        <div class="device-name">${escapeHtml(d.name)}</div>
        <div class="device-room">${escapeHtml(d.model)}</div>
        <div class="provider-badge ${d.provider}">${providerLabel}</div>
        <div class="device-status">${statusText}</div>
        ${controls}
      </div>`;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function attachSmartDeviceListeners(container) {
    // Toggle switches
    container.querySelectorAll('.toggle-switch[data-smart-toggle]').forEach(toggle => {
      toggle.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = parseInt(toggle.dataset.smartToggle);
        const device = smartDevices.find(d => d.id === id);
        if (!device) return;
        const action = device.is_on ? 'turn_off' : 'turn_on';
        toggle.style.opacity = '0.5';
        await controlSmartDevice(id, action);
        toggle.style.opacity = '';
      });
      toggle.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggle.click();
        }
      });
    });

    // Brightness sliders
    let brightnessTimeout = null;
    container.querySelectorAll('input[type="range"][data-smart-prop="brightness"]').forEach(slider => {
      slider.addEventListener('input', (e) => {
        const valueEl = slider.parentElement.querySelector('.slider-value');
        if (valueEl) valueEl.textContent = e.target.value + '%';
      });
      slider.addEventListener('change', (e) => {
        const id = parseInt(slider.dataset.smartDevice);
        const val = parseInt(e.target.value);
        clearTimeout(brightnessTimeout);
        brightnessTimeout = setTimeout(() => {
          controlSmartDevice(id, 'set_brightness', val);
        }, 300);
      });
    });

    // Sync button
    const syncBtn = document.getElementById('syncSmartBtn');
    if (syncBtn) {
      syncBtn.onclick = async () => {
        syncBtn.classList.add('syncing');
        await syncSmartDevices();
        syncBtn.classList.remove('syncing');
      };
    }
  }

  // =============================================
  // RENDER: SETTINGS VIEW (Smart Integrations)
  // =============================================
  async function renderSettingsView() {
    try {
      await loadSmartProviders();
    } catch (e) {
      // If API call fails, use fallback providers
      smartProviders = [
        { id: 'govee', name: 'Govee', description: 'Smart LED lights, strips, and home devices', key_label: 'Govee API Key', key_hint: 'Find at https://developer.govee.com — free tier available', connected: false },
        { id: 'lifx', name: 'LIFX', description: 'Smart WiFi light bulbs and strips', key_label: 'LIFX Personal Access Token', key_hint: 'Generate at https://cloud.lifx.com/settings', connected: false },
      ];
    }
    renderSmartProvidersGrid();
    initSmartConnectModal();
    initSyncAllButton();
  }

  function renderSmartProvidersGrid() {
    const container = document.getElementById('smartProvidersGrid');
    if (!container) return;

    container.innerHTML = smartProviders.map(p => {
      const connClass = p.connected ? ' connected' : '';
      const statusHtml = p.connected
        ? `<div class="smart-provider-status"><span class="status-indicator connected"></span> Connected${p.last_sync ? ' · Last synced: ' + formatRelativeTime(p.last_sync) : ''}</div>`
        : `<div class="smart-provider-status"><span class="status-indicator"></span> Not connected</div>`;

      const actionsHtml = p.connected
        ? `<div class="smart-provider-actions">
             <button class="btn-connect-provider reconnect" data-provider-action="reconnect" data-provider="${p.id}">Update Key</button>
             <button class="btn-connect-provider disconnect" data-provider-action="disconnect" data-provider="${p.id}">Disconnect</button>
           </div>`
        : `<div class="smart-provider-actions">
             <button class="btn-connect-provider connect" data-provider-action="connect" data-provider="${p.id}">Connect</button>
           </div>`;

      return `
        <div class="smart-provider-card${connClass}">
          <div class="smart-provider-header">
            <div class="smart-provider-logo ${p.id}">${p.name.charAt(0)}</div>
            <div class="smart-provider-info">
              <div class="smart-provider-name">${p.name}</div>
              <div class="smart-provider-desc">${p.description}</div>
            </div>
          </div>
          ${statusHtml}
          ${actionsHtml}
        </div>`;
    }).join('');

    // Attach provider button listeners
    container.querySelectorAll('[data-provider-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        const provider = btn.dataset.provider;
        const action = btn.dataset.providerAction;
        if (action === 'connect' || action === 'reconnect') {
          openConnectModal(provider);
        } else if (action === 'disconnect') {
          handleDisconnect(provider);
        }
      });
    });
  }

  function formatRelativeTime(dateStr) {
    if (!dateStr) return '';
    try {
      const d = new Date(dateStr + 'Z');
      const now = new Date();
      const diffMs = now - d;
      const diffMin = Math.floor(diffMs / 60000);
      if (diffMin < 1) return 'just now';
      if (diffMin < 60) return `${diffMin}m ago`;
      const diffHrs = Math.floor(diffMin / 60);
      if (diffHrs < 24) return `${diffHrs}h ago`;
      const diffDays = Math.floor(diffHrs / 24);
      return `${diffDays}d ago`;
    } catch (e) {
      return dateStr;
    }
  }

  function openConnectModal(provider) {
    const modal = document.getElementById('smartConnectModal');
    const titleEl = document.getElementById('modalProviderTitle');
    const hintEl = document.getElementById('modalProviderHint');
    const keyLabel = document.getElementById('modalKeyLabel');
    const iconEl = document.getElementById('modalProviderIcon');
    const input = document.getElementById('smartApiKeyInput');
    const errorEl = document.getElementById('smartConnectError');

    const prov = smartProviders.find(p => p.id === provider);
    if (!prov) return;

    connectModalProvider = provider;

    titleEl.textContent = `Connect ${prov.name}`;
    hintEl.textContent = prov.key_hint || '';
    keyLabel.textContent = prov.key_label || 'API Key';
    iconEl.className = `smart-connect-icon smart-provider-logo ${provider}`;
    iconEl.textContent = prov.name.charAt(0);
    input.value = '';
    errorEl.textContent = '';
    errorEl.classList.remove('visible');

    modal.style.display = '';
  }

  function closeConnectModal() {
    const modal = document.getElementById('smartConnectModal');
    if (modal) modal.style.display = 'none';
    connectModalProvider = null;
  }

  function initSmartConnectModal() {
    const modal = document.getElementById('smartConnectModal');
    const closeBtn = document.getElementById('smartConnectClose');
    const cancelBtn = document.getElementById('smartConnectCancel');
    const form = document.getElementById('smartConnectForm');
    const errorEl = document.getElementById('smartConnectError');

    if (closeBtn) closeBtn.onclick = closeConnectModal;
    if (cancelBtn) cancelBtn.onclick = closeConnectModal;

    // Close on backdrop click
    if (modal) {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) closeConnectModal();
      });
    }

    // Password toggle for API key
    const toggleBtns = modal ? modal.querySelectorAll('.password-toggle') : [];
    toggleBtns.forEach(btn => {
      btn.onclick = () => {
        const input = btn.closest('.password-wrapper').querySelector('input');
        if (!input) return;
        const isPassword = input.type === 'password';
        input.type = isPassword ? 'text' : 'password';
      };
    });

    if (form) {
      form.onsubmit = async (e) => {
        e.preventDefault();
        errorEl.textContent = '';
        errorEl.classList.remove('visible');

        const apiKey = document.getElementById('smartApiKeyInput').value.trim();
        if (!apiKey || apiKey.length < 10) {
          errorEl.textContent = 'Please enter a valid API key.';
          errorEl.classList.add('visible');
          return;
        }

        setButtonLoading('smartConnectBtn', true);

        const result = await connectProvider(connectModalProvider, apiKey);

        setButtonLoading('smartConnectBtn', false);

        if (!result.ok) {
          errorEl.textContent = result.error || 'Connection failed';
          errorEl.classList.add('visible');
          return;
        }

        showToast(`${result.data.message} (${result.data.devices_found} devices found)`, 'success');
        closeConnectModal();

        // Refresh providers and smart devices
        await loadSmartProviders();
        renderSmartProvidersGrid();
        await loadSmartDevices();
      };
    }
  }

  async function handleDisconnect(provider) {
    const prov = smartProviders.find(p => p.id === provider);
    if (!prov) return;

    // Simple confirmation
    const confirmed = confirm(`Disconnect from ${prov.name}? This will remove all synced devices from this provider.`);
    if (!confirmed) return;

    const result = await disconnectProvider(provider);
    if (result.ok) {
      showToast(result.data.message || 'Disconnected', 'success');
      smartDevices = smartDevices.filter(d => d.provider !== provider);
      await loadSmartProviders();
      renderSmartProvidersGrid();
    } else {
      showToast(result.error || 'Disconnect failed', 'error');
    }
  }

  function initSyncAllButton() {
    const syncBtn = document.getElementById('syncAllBtn');
    if (syncBtn) {
      syncBtn.onclick = async () => {
        syncBtn.classList.add('syncing');
        await syncSmartDevices();
        syncBtn.classList.remove('syncing');
        // Refresh providers to update last_sync time
        await loadSmartProviders();
        renderSmartProvidersGrid();
      };
    }
  }

  const searchInput = document.getElementById('searchInput');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      state.searchQuery = e.target.value;
      if (state.currentView === 'devices') {
        renderAllDevices();
      } else if (state.searchQuery.length > 0) {
        // Navigate to devices view and filter
        window.location.hash = '#devices';
      }
    });
  }

  // =============================================
  // SKELETON LOADING SIMULATION
  // =============================================
  function showSkeleton() {
    const container = document.getElementById('favoriteDevices');
    if (!container) return;
    container.innerHTML = Array(6).fill(0).map(() => `
      <div class="device-card" style="pointer-events:none;">
        <div class="device-card-header">
          <div class="device-icon skeleton" style="width:44px;height:44px;"></div>
          <div class="skeleton" style="width:44px;height:24px;border-radius:9999px;"></div>
        </div>
        <div class="skeleton skeleton-text" style="width:70%;"></div>
        <div class="skeleton skeleton-text" style="width:50%;"></div>
        <div class="skeleton skeleton-text" style="width:40%;margin-top:var(--space-2);"></div>
      </div>
    `).join('');
  }

  // =============================================
  // DASHBOARD INIT (called after auth success)
  // =============================================
  function initDashboard() {
    initTheme();
    // Show skeleton briefly, then render
    showSkeleton();
    setTimeout(() => {
      handleHash();
    }, 200);
  }

  // =============================================
  // INIT
  // =============================================
  async function init() {
    initTheme();
    initAuthUI();

    // Check for existing session
    const result = await checkSession();
    if (result.ok && result.data && result.data.user) {
      authToken = authToken; // already set if we had one from login
      currentUser = result.data.user;
      onAuthSuccess();
    } else {
      // No valid session — show auth screen
      authToken = null;
      currentUser = null;
      showAuthScreen();
    }
  }

  // Wait for DOM
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
