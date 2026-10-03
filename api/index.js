const db = require('./db');
const rateLimits = new Map();

function limited(key, max, windowMs) {
  const now = Date.now();
  const current = rateLimits.get(key);
  if (!current || current.until < now) {
    rateLimits.set(key, { count: 1, until: now + windowMs });
    return false;
  }
  current.count += 1;
  return current.count > max;
}

// Helper to parse request body
async function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        resolve({});
      }
    });
  });
}

// Helper for JSON response
function jsonResponse(res, status, data) {
  res.setHeader('Content-Type', 'application/json');
  res.status(status).send(JSON.stringify(data));
}

module.exports = async (req, res) => {
  const origin = req.headers.origin;
  if (origin) {
    try {
      if (new URL(origin).host === req.headers.host) res.setHeader('Access-Control-Allow-Origin', origin);
    } catch {}
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  try {
    // === PUBLIC ROUTES ===
    
    // Register. Keep both names so local and Vercel clients share one contract.
    if ((pathname === '/api/register' || pathname === '/api/request') && req.method === 'POST') {
      if (limited(`register:${req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown'}`, 5, 3600000)) {
        return jsonResponse(res, 429, { error: 'Muitas solicitações. Tente novamente mais tarde.' });
      }
      const body = await parseBody(req);
      const { email, password, name } = body;

      if (!email || !password) {
        return jsonResponse(res, 400, { error: 'Email and password required' });
      }

      if (password.length < 12 || !/[a-zA-Z]/.test(password) || !/\d/.test(password)) {
        return jsonResponse(res, 400, { error: 'Senha: 12+ caracteres com letras e números.' });
      }

      try {
        const result = db.createUser(email, password, name);
        return jsonResponse(res, 202, {
          message: 'Registration submitted. Awaiting admin approval.',
          ...result
        });
      } catch (error) {
        return jsonResponse(res, 409, { error: error.message });
      }
    }

    // Login
    if (pathname === '/api/login' && req.method === 'POST') {
      const body = await parseBody(req);
      const { email, password } = body;

      if (limited(`login:${req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown'}:${email || ''}`, 8, 900000)) {
        return jsonResponse(res, 429, { error: 'Muitas tentativas. Aguarde 15 minutos.' });
      }

      if (!email || !password) {
        return jsonResponse(res, 400, { error: 'Email and password required' });
      }

      try {
        const result = db.login(email, password);
        return jsonResponse(res, 200, result);
      } catch (error) {
        return jsonResponse(res, 401, { error: error.message });
      }
    }

    // === PROTECTED ROUTES (require authentication) ===
    
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      return jsonResponse(res, 401, { error: 'Unauthorized - No token provided' });
    }

    let session;
    try {
      session = db.verifyToken(token);
    } catch (error) {
      return jsonResponse(res, 401, { error: 'Unauthorized - ' + error.message });
    }

    // === USER ROUTES ===

    // Get current user info
    if (pathname === '/api/me' && req.method === 'GET') {
      return jsonResponse(res, 200, db.getUser(session.userId) || session);
    }

    // Get todos
    if ((pathname === '/api/todos' || pathname === '/api/tasks') && req.method === 'GET') {
      const todos = db.getTodos(session.userId);
      return jsonResponse(res, 200, { tasks: todos });
    }

    // Create todo
    if ((pathname === '/api/todos' || pathname === '/api/tasks') && req.method === 'POST') {
      const body = await parseBody(req);
      const todo = db.createTodo(session.userId, body);
      return jsonResponse(res, 201, todo);
    }

    // Update todo
    if (pathname.match(/^\/api\/(todos|tasks)\/[^/]+$/) && req.method === 'PATCH') {
      const todoId = pathname.split('/').pop();
      const body = await parseBody(req);
      
      try {
        const todo = db.updateTodo(todoId, session.userId, body);
        return jsonResponse(res, 200, todo);
      } catch (error) {
        return jsonResponse(res, 404, { error: error.message });
      }
    }

    // Delete todo
    if (pathname.match(/^\/api\/(todos|tasks)\/[^/]+$/) && req.method === 'DELETE') {
      const todoId = pathname.split('/').pop();
      
      try {
        db.deleteTodo(todoId, session.userId);
        return jsonResponse(res, 204, null);
      } catch (error) {
        return jsonResponse(res, 404, { error: error.message });
      }
    }

    // === ADMIN ROUTES ===
    
    if (session.role !== 'admin') {
      if (pathname.startsWith('/api/admin/')) {
        return jsonResponse(res, 403, { error: 'Admin access required' });
      }
    }

    // Get pending users
    if (pathname === '/api/admin/pending' && req.method === 'GET') {
      const pending = db.getPendingUsers();
      return jsonResponse(res, 200, pending);
    }

    // Approve user
    if (pathname === '/api/admin/approve' && req.method === 'POST') {
      const body = await parseBody(req);
      const { userId } = body;

      if (!userId) {
        return jsonResponse(res, 400, { error: 'userId required' });
      }

      try {
        const result = db.approveUser(userId);
        return jsonResponse(res, 200, result);
      } catch (error) {
        return jsonResponse(res, 404, { error: error.message });
      }
    }

    const adminAction = pathname.match(/^\/api\/admin\/users\/([^/]+)\/(approve|deny|block|unblock|kill)$/);
    if (adminAction && req.method === 'POST') {
      const [, userId, action] = adminAction;
      try {
        if (action === 'approve') return jsonResponse(res, 200, db.approveUser(userId));
        if (action === 'deny') return jsonResponse(res, 200, db.rejectUser(userId));
        return jsonResponse(res, 200, db.updateUser(userId, action));
      } catch (error) {
        return jsonResponse(res, 404, { error: error.message });
      }
    }

    // Reject user
    if (pathname === '/api/admin/reject' && req.method === 'POST') {
      const body = await parseBody(req);
      const { userId } = body;

      if (!userId) {
        return jsonResponse(res, 400, { error: 'userId required' });
      }

      try {
        const result = db.rejectUser(userId);
        return jsonResponse(res, 200, result);
      } catch (error) {
        return jsonResponse(res, 404, { error: error.message });
      }
    }

    // Get all users
    if (pathname === '/api/admin/users' && req.method === 'GET') {
      const users = db.getAllUsers();
      return jsonResponse(res, 200, { users, logs: [], totalTasks: db.getTotalTodos(), activeSessions: 0 });
    }

    // 404
    return jsonResponse(res, 404, { error: 'Not found' });

  } catch (error) {
    console.error('API Error:', error);
    return jsonResponse(res, 500, { error: 'Internal server error' });
  }
};
