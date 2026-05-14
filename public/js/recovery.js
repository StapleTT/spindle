const SVG_MARK = (sz) => `<svg width="${sz}" height="${sz}" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" style="display:inline-block;vertical-align:middle;flex-shrink:0">
  <path d="M 78 22 C 78 12, 60 8, 44 12 C 28 16, 22 28, 32 38 C 40 46, 60 46, 60 46" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round"/>
  <path d="M 22 78 C 22 88, 40 92, 56 88 C 72 84, 78 72, 68 62 C 60 54, 40 54, 40 54" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round"/>
  <path d="M 50 6 L 51.6 50 L 48.4 50 Z" fill="currentColor"/>
  <rect x="48.6" y="50" width="2.8" height="40" fill="currentColor"/>
  <ellipse cx="50" cy="92" rx="9" ry="1.8" fill="currentColor"/>
</svg>`;
const LOCKUP = (sz,gap) => `<span style="display:inline-flex;align-items:center;gap:${gap}px;line-height:1">${SVG_MARK(sz*1.3)}<span style="font-size:${sz}px;font-weight:600;letter-spacing:0.02em">spindle</span></span>`;
const hero = (tags,cmd) =>
  `<div class="auth-prompt"><span class="prompt-path">~/spindle&nbsp;$&nbsp;</span><span class="prompt-cmd">./auth.sh</span><span class="prompt-flag">&nbsp;${cmd}</span><span class="cursor"></span></div>
   <div class="auth-logo-wrap">${LOCKUP(36,14)}</div>
   <div class="auth-tag">${tags.map(t=>`<span>${t}</span>`).join('<span class="sep">·</span>')}</div>`;
const statusLine = (kind,html) => `<div class="auth-status"><span class="dot ${kind}"></span><span>${html}</span></div>`;
const secLabel = (text) => `<div class="auth-section-label"><span class="slash">//</span>${text}</div>`;
const fld = (label,inp,errId,opt) =>
  `<div class="field">
     <div class="field-label"><span class="slash">//</span>${label}${opt?'<span class="opt">— optional</span>':''}</div>
     ${inp}
     <div class="field-error" id="${errId}" style="display:none"></div>
   </div>`;

function showErr(id,msg){
  const el=document.getElementById(id); if(!el)return;
  el.textContent=msg; el.style.display=msg?'flex':'none';
  const sib=el.previousElementSibling;
  const inp=sib&&(sib.classList.contains('input')?sib:sib.querySelector&&sib.querySelector('.input'));
  if(inp)inp.classList.toggle('error',!!msg);
}
async function post(url,body){
  try{const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return{ok:r.ok,data:await r.json()};}
  catch{return{ok:false,data:{error:'Network error'}};}
}

const getReqs=(p)=>({len:p.length>=12,upper:/[A-Z]/.test(p),num:/[0-9]/.test(p),sym:/[!@#$%^&*()\-_=+[\]{};:,.<>?\\/|~`]/.test(p)});
function updateReqs(p){
  const r=getReqs(p),all=Object.values(r).every(Boolean);
  const st=document.getElementById('rq-st');
  if(st){if(!p){st.className='req-status dash';st.textContent='— no password';}
    else if(all){st.className='req-status met';st.textContent='— meets requirements';}
    else{st.className='req-status bad';st.textContent='— does not meet requirements';}}
  [['len','rq-len'],['upper','rq-up'],['num','rq-num'],['sym','rq-sym']].forEach(([k,id])=>{const el=document.getElementById(id);if(el)el.classList.toggle('met',r[k]);});
}

function renderReset(token) {
  document.getElementById('root').innerHTML = `<div class="auth-shell">
    ${hero(['password reset','new credentials'],'--reset')}
    ${secLabel('new password')}
    <div class="card">
      ${fld('new password',
        `<div class="input-wrap">
           <input class="input" id="np" type="password" placeholder="············">
           <span class="input-suffix" id="np-t">show</span>
         </div>
         <div class="req-status dash" id="rq-st">— no password</div>
         <ul class="req-list">
           <li id="rq-len">at least 12 characters</li>
           <li id="rq-up">uppercase letter</li>
           <li id="rq-num">number</li>
           <li id="rq-sym">symbol (!@#$…)</li>
         </ul>`,
        'np-err')}
      ${fld('confirm password',
        `<div class="input-wrap">
           <input class="input" id="cp" type="password" placeholder="············">
           <span class="input-suffix" id="cp-t">show</span>
         </div>`,
        'cp-err')}
      <button class="btn" id="reset-go">[ set new password ] <span class="ret">↵</span></button>
    </div>
    <div class="auth-footer"><div><a href="/auth">← back to login</a></div><div></div></div>
  </div>`;

  [['np','np-t'],['cp','cp-t']].forEach(([inp,tog])=>{
    const i=document.getElementById(inp),t=document.getElementById(tog);
    t.onclick=()=>{const s=i.type==='text';i.type=s?'password':'text';t.textContent=s?'show':'hide';};
  });
  document.getElementById('np').addEventListener('input',e=>updateReqs(e.target.value));

  document.getElementById('reset-go').addEventListener('click', async () => {
    const p=document.getElementById('np').value, cp=document.getElementById('cp').value;
    showErr('np-err',''); showErr('cp-err','');
    const rqs=getReqs(p), allMet=Object.values(rqs).every(Boolean);
    let v=true;
    if(!allMet){showErr('np-err','password does not meet requirements');v=false;}
    if(p!==cp) {showErr('cp-err','passwords do not match');v=false;}
    if(!v) return;
    const btn=document.getElementById('reset-go');
    btn.disabled=true; btn.innerHTML='[ updating… ]';
    const res=await post('/api/auth/recovery/reset',{token,new_password:p});
    if(res.ok){
      document.getElementById('root').innerHTML = `<div class="auth-shell">
        ${hero(['password reset','complete'],'--reset')}
        ${statusLine('ok','password updated successfully')}
        <div class="card">
          <div class="card-info">Your password has been updated. You can now log in with your new credentials.</div>
          <button class="btn" id="reset-done">[ go to login ] <span class="ret">↵</span></button>
        </div>
      </div>`;
      document.getElementById('reset-done').addEventListener('click', () => { location.href = '/auth'; });
    } else {
      btn.disabled=false; btn.innerHTML='[ set new password ] <span class="ret">↵</span>';
      showErr('np-err', res.data.error || 'Reset failed. The link may have expired.');
    }
  });
}

function renderInvalid() {
  document.getElementById('root').innerHTML = `<div class="auth-shell">
    ${hero(['account recovery','reset access'],'--recover')}
    ${statusLine('err','invalid or expired reset link')}
    <div class="card">
      <div class="card-info">This reset link is invalid or has already been used. Request a new one from the login page.</div>
      <button class="btn" id="invalid-back">[ back to login ] <span class="ret">↵</span></button>
    </div>
  </div>`;
  document.getElementById('invalid-back').addEventListener('click', () => { location.href = '/auth'; });
}

// Read token from query string
(()=>{
  const token = new URLSearchParams(location.search).get('token');
  if (!token) { renderInvalid(); return; }
  renderReset(token);
})();
