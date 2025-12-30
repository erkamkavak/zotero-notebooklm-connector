const toast = document.getElementById('status-toast');
const toastText = document.getElementById('toast-text');
const projectList = document.getElementById('project-list');
const emptyState = document.getElementById('empty-state');
const mainView = document.getElementById('main-view');
const formView = document.getElementById('form-view');

const addBtn = document.getElementById('add-project-btn');
const cancelBtn = document.getElementById('cancel-btn');
const saveBtn = document.getElementById('save-btn');

let projects = [];

const icons = {
    plus: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>`,
    refresh: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>`,
    pencil: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path></svg>`,
    trash: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>`,
    folder: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>`,
    tag: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"></path><line x1="7" y1="7" x2="7.01" y2="7"></line></svg>`,
    info: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>`
};

// Set the header icon
document.getElementById('add-project-btn').innerHTML = icons.plus;
document.querySelector('#status-toast i').outerHTML = icons.info;

// Initialize
async function load() {
    const data = await chrome.storage.local.get('projects');
    projects = data.projects || [];
    render();
}

function showToast(text, duration = 3000) {
    toastText.textContent = text;
    toast.classList.add('show');
    if (duration > 0) {
        setTimeout(() => toast.classList.remove('show'), duration);
    }
}

function render() {
    projectList.innerHTML = '';
    if (projects.length === 0) {
        emptyState.classList.remove('hidden');
    } else {
        emptyState.classList.add('hidden');
        projects.forEach((p, i) => {
            const card = document.createElement('div');
            card.className = 'project-card';
            
            let metaHtml = '';
            if (p.collection) {
                metaHtml += `
                    <div class="meta-item">
                        ${icons.folder}
                        <span>${p.collection}</span>
                    </div>
                `;
            }
            if (p.tag) {
                metaHtml += `
                    <div class="meta-item">
                        ${icons.tag}
                        <span>${p.tag}</span>
                    </div>
                `;
            }
            
            card.innerHTML = `
                <div class="project-title">${p.name}</div>
                <div class="project-meta">${metaHtml || 'No filters active'}</div>
                <div class="actions">
                    <button class="btn-sync" data-index="${i}">
                        ${icons.refresh}
                        Sync
                    </button>
                    <button class="btn-icon edit-btn" data-index="${i}" title="Edit">
                        ${icons.pencil}
                    </button>
                    <button class="btn-icon delete-btn delete" data-index="${i}" title="Delete">
                        ${icons.trash}
                    </button>
                </div>
            `;
            projectList.appendChild(card);
        });
    }

    // Bindings
    document.querySelectorAll('.btn-sync').forEach(b => b.addEventListener('click', e => {
        const btn = e.currentTarget;
        const icon = btn.querySelector('svg');
        if (icon) icon.style.animation = 'spin 1s linear infinite';
        
        startSync(projects[btn.dataset.index]);
    }));

    document.querySelectorAll('.edit-btn').forEach(b => b.addEventListener('click', e => {
        showForm(projects[e.currentTarget.dataset.index], e.currentTarget.dataset.index);
    }));

    document.querySelectorAll('.delete-btn').forEach(b => b.addEventListener('click', e => {
        const idx = e.currentTarget.dataset.index;
        if (confirm(`Delete project "${projects[idx].name}"?`)) {
            projects.splice(idx, 1);
            save();
        }
    }));
}

// Add CSS for rotation animation dynamically
const style = document.createElement('style');
style.textContent = `
    @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
`;
document.head.append(style);

function showForm(p = null, idx = -1) {
    document.getElementById('p-name').value = p ? p.name : '';
    document.getElementById('p-tag').value = p ? p.tag : '';
    document.getElementById('p-collection').value = p ? p.collection : '';
    document.getElementById('p-library').value = p ? (p.libraryID || '0') : '0';
    document.getElementById('edit-id').value = idx;
    document.getElementById('form-title-text').textContent = p ? 'Edit Project' : 'New Project';
    
    mainView.classList.add('hidden');
    formView.classList.remove('hidden');
}

function hideForm() {
    mainView.classList.remove('hidden');
    formView.classList.add('hidden');
}

async function save() {
    await chrome.storage.local.set({ projects });
    render();
}

saveBtn.addEventListener('click', async () => {
    const name = document.getElementById('p-name').value.trim();
    if (!name) return alert('Please enter a project name.');

    const idx = parseInt(document.getElementById('edit-id').value);
    const p = {
        name,
        tag: document.getElementById('p-tag').value.trim(),
        collection: document.getElementById('p-collection').value.trim(),
        libraryID: document.getElementById('p-library').value.trim()
    };

    if (idx === -1) {
        projects.push(p);
    } else {
        projects[idx] = p;
    }

    await save();
    hideForm();
});

addBtn.addEventListener('click', () => showForm());
cancelBtn.addEventListener('click', hideForm);

function startSync(project) {
    showToast(`Syncing "${project.name}"...`, 0);
    chrome.runtime.sendMessage({ action: "START_SYNC", project: project }, (res) => {
        if (chrome.runtime.lastError) {
             showToast("Error connecting to background script.");
        } else {
             // Status will be updated via listener
        }
    });
}

chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === "UPDATE_STATUS") {
        showToast(msg.text, msg.text.includes("complete") || msg.text.includes("Error") ? 4000 : 0);
        
        // Stop spinning if complete
        if (msg.text.includes("complete") || msg.text.includes("Error") || msg.text.includes("up to date")) {
            render();
        }
    }
});

load();