const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Use process.env for storage path, fallback to /tmp
const STORAGE_PATH = process.env.STORAGE_PATH || '/tmp';
const USERS_FILE = path.join(STORAGE_PATH, 'nexa_users.json');
const TODOS_FILE = path.join(STORAGE_PATH, 'nexa_todos.json');

// Admin credentials (fixed)
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'yagopinto').toLowerCase();
const ADMIN_SALT = 'nexa-admin-v4';
const ADMIN_HASH = '2ee00491708ea4bc63329a45f4bed9947d56c6eb91e2b8821d00585aa08817aebb9ec3dd75cb3cb7' +
  '6ff03b9f48a314ce603e8b724cc411caf85b9038a39dcaf7';

class Database {
  constructor() {
    this.initStorage();
  }

  initStorage() {
    // Initialize users with admin
    if (!fs.existsSync(USERS_FILE)) {
      const initialData = {
        users: [{
          id: '1',
          name: 'Admin',
          email: ADMIN_EMAIL,
          hash: process.env.ADMIN_PASSWORD ? crypto.scryptSync(process.env.ADMIN_PASSWORD, ADMIN_SALT, 64).toString('hex') : ADMIN_HASH,
          salt: ADMIN_SALT,
          role: 'admin',
          status: 'approved',
          createdAt: new Date().toISOString()
        }],
        pendingUsers: [],
        sessions: {}
      };
      fs.writeFileSync(USERS_FILE, JSON.stringify(initialData, null, 2));
    }

    // Initialize todos
    if (!fs.existsSync(TODOS_FILE)) {
      fs.writeFileSync(TODOS_FILE, JSON.stringify({ todos: [] }, null, 2));
    }

    // Ensure admin exists on every cold start
    this.ensureAdmin();
  }

  ensureAdmin() {
    const data = this.readUsers();
    const adminExists = data.users.some(u => u.email === ADMIN_EMAIL);
    
    if (!adminExists) {
      data.users.push({
        id: Date.now().toString(),
        name: 'Admin',
        email: ADMIN_EMAIL,
        hash: process.env.ADMIN_PASSWORD ? crypto.scryptSync(process.env.ADMIN_PASSWORD, ADMIN_SALT, 64).toString('hex') : ADMIN_HASH,
        salt: ADMIN_SALT,
        role: 'admin',
        status: 'approved',
        createdAt: new Date().toISOString()
      });
      this.writeUsers(data);
    }
  }

  readUsers() {
    try {
      const content = fs.readFileSync(USERS_FILE, 'utf8');
      return JSON.parse(content);
    } catch (error) {
      return { users: [], pendingUsers: [], sessions: {} };
    }
  }

  writeUsers(data) {
    fs.writeFileSync(USERS_FILE, JSON.stringify(data, null, 2));
  }

  readTodos() {
    try {
      const content = fs.readFileSync(TODOS_FILE, 'utf8');
      return JSON.parse(content);
    } catch (error) {
      return { todos: [] };
    }
  }

  writeTodos(data) {
    fs.writeFileSync(TODOS_FILE, JSON.stringify(data, null, 2));
  }

  // User operations
  createUser(email, password, name = '') {
    const data = this.readUsers();
    
    // Check if exists
    if (data.users.some(u => u.email === email) || 
        data.pendingUsers.some(u => u.email === email)) {
      throw new Error('Email already registered');
    }

    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');

    const pendingUser = {
      id: Date.now().toString(),
      name: String(name || email.split('@')[0]).trim(),
      email,
      hash,
      salt,
      role: 'user',
      status: 'pending',
      requestedAt: new Date().toISOString()
    };

    data.pendingUsers.push(pendingUser);
    this.writeUsers(data);
    
    return { id: pendingUser.id, email, status: 'pending' };
  }

  login(email, password) {
    const data = this.readUsers();
    const user = data.users.find(u => u.email === email);

    if (!user) {
      throw new Error('Invalid credentials');
    }

    if (user.status !== 'approved') {
      throw new Error('Account pending approval');
    }

    const hash = crypto.scryptSync(password, user.salt, 64).toString('hex');
    if (hash !== user.hash) {
      throw new Error('Invalid credentials');
    }

    const token = crypto.randomBytes(32).toString('hex');
    data.sessions[token] = {
      userId: user.id,
      email: user.email,
      role: user.role,
      createdAt: Date.now()
    };
    this.writeUsers(data);

    return {
      token,
      id: user.id,
      name: user.name || user.email.split('@')[0],
      email: user.email,
      role: user.role,
      status: user.status,
      xp: user.xp || 0,
      streak: user.streak || 0,
      focusMinutes: user.focusMinutes || 0,
      preferences: user.preferences || { theme: 'dark', defaultView: 'list', notifications: true }
    };
  }

  getUser(userId) {
    const data = this.readUsers();
    const user = data.users.find(u => u.id === userId);
    if (!user) return null;
    return {
      id: user.id,
      name: user.name || user.email.split('@')[0],
      email: user.email,
      role: user.role,
      status: user.status,
      xp: user.xp || 0,
      streak: user.streak || 0,
      focusMinutes: user.focusMinutes || 0,
      preferences: user.preferences || { theme: 'dark', defaultView: 'list', notifications: true }
    };
  }

  verifyToken(token) {
    const data = this.readUsers();
    const session = data.sessions[token];
    
    if (!session) {
      throw new Error('Invalid session');
    }

    // Session expires after 7 days
    if (Date.now() - session.createdAt > 7 * 24 * 60 * 60 * 1000) {
      delete data.sessions[token];
      this.writeUsers(data);
      throw new Error('Session expired');
    }

    return session;
  }

  // Admin operations
  getPendingUsers() {
    const data = this.readUsers();
    return data.pendingUsers.map(u => ({
      id: u.id,
      name: u.name || u.email.split('@')[0],
      email: u.email,
      requestedAt: u.requestedAt
    }));
  }

  approveUser(userId) {
    const data = this.readUsers();
    const index = data.pendingUsers.findIndex(u => u.id === userId);
    
    if (index === -1) {
      throw new Error('User not found');
    }

    const user = data.pendingUsers[index];
    user.status = 'approved';
    user.approvedAt = new Date().toISOString();
    
    data.users.push(user);
    data.pendingUsers.splice(index, 1);
    
    this.writeUsers(data);
    return { email: user.email, status: 'approved' };
  }

  rejectUser(userId) {
    const data = this.readUsers();
    const index = data.pendingUsers.findIndex(u => u.id === userId);
    
    if (index === -1) {
      throw new Error('User not found');
    }

    const user = data.pendingUsers[index];
    data.pendingUsers.splice(index, 1);
    
    this.writeUsers(data);
    return { email: user.email, status: 'rejected' };
  }

  getAllUsers() {
    const data = this.readUsers();
    return data.users.map(u => ({
      id: u.id,
      name: u.name || u.email.split('@')[0],
      email: u.email,
      role: u.role,
      status: u.status,
      createdAt: u.createdAt,
      last: u.last || null,
      xp: u.xp || 0
    }));
  }

  updateUser(userId, action) {
    const data = this.readUsers();
    const user = data.users.find(u => u.id === userId);
    if (!user) throw new Error('User not found');
    if (action === 'block') user.status = 'blocked';
    else if (action === 'unblock') user.status = 'approved';
    else if (action === 'promote') user.role = 'admin';
    else if (action === 'demote') user.role = 'user';
    else if (action === 'kill') data.sessions = Object.fromEntries(Object.entries(data.sessions).filter(([, session]) => session.userId !== userId));
    else throw new Error('Invalid user action');
    this.writeUsers(data);
    return { ok: true, action, userId };
  }

  getTotalTodos() {
    return this.readTodos().todos.length;
  }

  // Todo operations
  getTodos(userId) {
    const data = this.readTodos();
    return data.todos.filter(t => t.userId === userId);
  }

  createTodo(userId, todoData) {
    const data = this.readTodos();
    const todo = {
      id: Date.now().toString(),
      userId,
      ...todoData,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    data.todos.push(todo);
    this.writeTodos(data);
    return todo;
  }

  updateTodo(todoId, userId, updates) {
    const data = this.readTodos();
    const index = data.todos.findIndex(t => t.id === todoId && t.userId === userId);
    
    if (index === -1) {
      throw new Error('Todo not found');
    }

    data.todos[index] = {
      ...data.todos[index],
      ...updates,
      updatedAt: new Date().toISOString()
    };
    
    this.writeTodos(data);
    return data.todos[index];
  }

  deleteTodo(todoId, userId) {
    const data = this.readTodos();
    const initialLength = data.todos.length;
    data.todos = data.todos.filter(t => !(t.id === todoId && t.userId === userId));
    
    if (data.todos.length === initialLength) {
      throw new Error('Todo not found');
    }
    
    this.writeTodos(data);
  }
}

module.exports = new Database();
