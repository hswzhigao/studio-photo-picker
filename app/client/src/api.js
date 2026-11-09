async function request(path, options = {}) {
  const hasBody = options.body !== undefined;
  const response = await fetch(path, {
    credentials: 'include',
    ...options,
    headers: {
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw data.error || { code: 'REQUEST_FAILED', message: '请求失败' };
  return data;
}

function uploadFile(path, file, { method = 'POST', onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, path);
    xhr.withCredentials = true;
    xhr.upload.onprogress = event => {
      if (event.lengthComputable && onProgress) onProgress(Math.round(event.loaded / event.total * 100));
    };
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText || '{}'); } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(data.error || { code: 'REQUEST_FAILED', message: '上传失败' });
    };
    xhr.onerror = () => reject({ code: 'NETWORK_ERROR', message: '网络错误，请检查连接后重试' });
    xhr.onabort = () => reject({ code: 'ABORTED', message: '上传已取消' });
    const form = new FormData();
    form.append('photo', file, file.name);
    xhr.send(form);
  });
}

export const api = {
  get: path => request(path),
  post: (path, body) => request(path, { method: 'POST', body: JSON.stringify(body || {}) }),
  put: (path, body) => request(path, { method: 'PUT', body: JSON.stringify(body || {}) }),
  patch: (path, body) => request(path, { method: 'PATCH', body: JSON.stringify(body || {}) }),
  del: (path, body) => request(path, { method: 'DELETE', ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
  upload: uploadFile,
};
