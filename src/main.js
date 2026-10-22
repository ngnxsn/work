// Entry: load styles, then start the 3D edit suite only where WebGL works.
// Without it (or without JS) the plain HTML fallback in index.html stays visible.
import './styles.css';

function hasWebGL(){
  try {
    const c = document.createElement('canvas');
    return !!(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl')));
  } catch { return false; }
}

if (hasWebGL()) import('./app.js');
else document.documentElement.classList.add('no-webgl');
