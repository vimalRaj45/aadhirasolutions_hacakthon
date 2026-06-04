const path = require('path');
const fs = require('fs');
const fastify = require('fastify')({ 
  logger: true,
  trustProxy: true
});
const { Pool } = require('pg');
require('dotenv').config();

// Port & Host configurations
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// Initialize PostgreSQL connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // Required for Neon SSL
});

// Configure plugins
fastify.register(require('@fastify/static'), {
  root: path.join(__dirname, 'public'),
  prefix: '/', 
});

fastify.register(require('@fastify/multipart'), {
  limits: {
    fieldNameSize: 100, // Max field name size in bytes
    fieldSize: 1000000, // Max field value size in bytes (1MB)
    fields: 20,         // Max number of non-file fields
    fileSize: 2097152,  // Max file size in bytes (2MB)
    files: 1            // Max number of file fields
  }
});

// Create registrations table if not exists (preserves data across restarts)
async function initDb() {
  const createText = `
    CREATE TABLE IF NOT EXISTS registrations (
      id SERIAL PRIMARY KEY,
      team_name VARCHAR(100) NOT NULL,
      college_name VARCHAR(255) NOT NULL,
      leader_name VARCHAR(100) NOT NULL,
      leader_email VARCHAR(255) NOT NULL,
      leader_phone VARCHAR(20) NOT NULL,
      member2_name VARCHAR(100) NOT NULL,
      member2_phone VARCHAR(20) NOT NULL,
      member3_name VARCHAR(100) NOT NULL,
      member3_phone VARCHAR(20) NOT NULL,
      member4_name VARCHAR(100) NOT NULL,
      member4_phone VARCHAR(20) NOT NULL,
      problem_statement TEXT NOT NULL,
      payment_proof_data BYTEA NOT NULL,
      payment_proof_mime VARCHAR(100) NOT NULL,
      status VARCHAR(20) DEFAULT 'Pending',
      attended BOOLEAN DEFAULT FALSE,
      attended_at TIMESTAMP NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `;
  try {
    const client = await pool.connect();
    await client.query(createText);
    
    // Auto-migrate to add team_name if it doesn't exist
    await client.query(`
      ALTER TABLE registrations 
      ADD COLUMN IF NOT EXISTS team_name VARCHAR(100) DEFAULT 'Unnamed Team';
    `);

    // Create tickets table
    await client.query(`
      CREATE TABLE IF NOT EXISTS tickets (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        leader_email VARCHAR(255) NOT NULL,
        message TEXT NOT NULL,
        status VARCHAR(20) DEFAULT 'Open',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    client.release();
    fastify.log.info('Database table "registrations" checked/initialized with BLOB support successfully.');
  } catch (err) {
    fastify.log.error('Failed to initialize database table:', err);
    process.exit(1);
  }
}

// Brevo Mail Sender Function
async function sendBrevoEmail({ toEmail, toName, subject, htmlContent, attachment }) {
  const apiKey = process.env.BREVO_API_KEY;
  const senderName = process.env.BREVO_SENDER_NAME || 'Aadhira Solutions';
  const senderEmail = process.env.BREVO_SENDER_EMAIL || 'vsgrpsemail@gmail.com';

  if (!apiKey || apiKey.startsWith('xkeysib-xxxx') || apiKey === '') {
    fastify.log.warn('----------------------------------------------------');
    fastify.log.warn('WARNING: Brevo API key is not configured or is a placeholder.');
    fastify.log.warn(`EMAIL WOULD HAVE BEEN SENT TO: ${toName} <${toEmail}>`);
    fastify.log.warn(`SUBJECT: ${subject}`);
    fastify.log.warn(`ATTACHMENT: ${attachment ? JSON.stringify(attachment) : 'NONE'}`);
    fastify.log.warn(`HTML CONTENT PREVIEW:\n${htmlContent}`);
    fastify.log.warn('----------------------------------------------------');
    return { mock: true, success: true };
  }

  try {
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': apiKey,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        sender: { name: senderName, email: senderEmail },
        to: [{ email: toEmail, name: toName }],
        subject: subject,
        htmlContent: htmlContent,
        ...(attachment ? { attachment } : {})
      })
    });

    const data = await response.json();
    if (response.ok) {
      fastify.log.info(`Email successfully sent to ${toEmail} via Brevo. MessageId: ${data.messageId}`);
      return { success: true, messageId: data.messageId };
    } else {
      fastify.log.error('Brevo API Error Response:', data);
      return { success: false, error: data };
    }
  } catch (error) {
    fastify.log.error('Error occurred while calling Brevo API:', error);
    return { success: false, error: error.message };
  }
}

// Helper to stream file into memory Buffer
function concatStream(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', (err) => reject(err));
  });
}

// In-memory storage for OTPs and sessions
const activeOtps = new Map(); // email -> { otp, expiresAt }
const activeSessions = new Set(); // set of valid session tokens
const registrationOtps = new Map(); // email -> { otp, expiresAt }
const verifiedRegistrationEmails = new Set(); // set of verified leader emails

// Rate limiting and IP blocking store (in-memory)
const rateLimitStore = new Map(); // IP -> { count, windowStart, blockedUntil }

fastify.addHook('onRequest', async (request, reply) => {
  // Only process API routes
  if (!request.url.startsWith('/api/')) {
    return;
  }

  // Same-origin checks to block CSRF and unauthorized cross-origin calls
  const host = request.headers.host;
  const origin = request.headers.origin;
  const referer = request.headers.referer;

  if (origin) {
    try {
      const originHost = new URL(origin).host;
      if (originHost !== host) {
        reply.status(403).send({ success: false, error: 'Forbidden: Cross-Origin request blocked.' });
        return;
      }
    } catch (err) {
      reply.status(400).send({ success: false, error: 'Bad Request: Invalid Origin header.' });
      return;
    }
  }

  if (referer) {
    try {
      const refererHost = new URL(referer).host;
      if (refererHost !== host) {
        reply.status(403).send({ success: false, error: 'Forbidden: Cross-Origin request blocked.' });
        return;
      }
    } catch (err) {
      reply.status(400).send({ success: false, error: 'Bad Request: Invalid Referer header.' });
      return;
    }
  }

  const ip = request.ip || 'unknown';
  const now = Date.now();
  const record = rateLimitStore.get(ip);

  // Check if IP is currently blocked
  if (record && record.blockedUntil && now < record.blockedUntil) {
    const timeLeft = Math.ceil((record.blockedUntil - now) / 1000);
    reply.status(429).send({
      success: false,
      error: `Too many requests from this IP. Please try again after ${timeLeft} seconds.`
    });
    return;
  }

  const limitWindow = 60 * 1000; // 1 minute window
  const maxRequests = 10;        // max 10 API requests per minute per IP
  const blockDuration = 5 * 60 * 1000; // 5 minutes block on breach

  if (!record || now - record.windowStart > limitWindow) {
    // Start a new window
    rateLimitStore.set(ip, {
      count: 1,
      windowStart: now,
      blockedUntil: null
    });
  } else {
    record.count++;
    if (record.count > maxRequests) {
      record.blockedUntil = now + blockDuration;
      fastify.log.warn(`IP Rate Limit Violation: Blocked ${ip}`);
      reply.status(429).send({
        success: false,
        error: `Too many requests. Your IP has been temporarily blocked for 5 minutes.`
      });
      return;
    }
  }
});


// Authentication Helper: Verify Session Token
async function verifyAdminSession(request, reply) {
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    reply.status(401).send({ success: false, error: 'Unauthorized: Missing or invalid session token.' });
    throw new Error('Unauthorized');
  }

  const token = authHeader.substring(7);
  if (!activeSessions.has(token)) {
    reply.status(401).send({ success: false, error: 'Unauthorized: Session has expired or is invalid.' });
    throw new Error('Unauthorized');
  }
}

// API Routes

// 0. Auth: Send OTP (One-Time Password)
fastify.post('/api/auth/send-otp', async (request, reply) => {
  const { email } = request.body || {};
  if (!email || email.trim() === '') {
    return reply.status(400).send({ success: false, error: 'Email address is required.' });
  }

  const normalizedEmail = email.trim().toLowerCase();
  
  // Verify against whitelist in env
  const whitelist = (process.env.ALLOWED_ADMIN_EMAILS || '')
    .split(',')
    .map(e => e.trim().toLowerCase());

  if (!whitelist.includes(normalizedEmail)) {
    return reply.status(401).send({ success: false, error: 'This email is not authorized to access the Admin Panel.' });
  }

  // Generate 6-digit numeric OTP
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = Date.now() + 5 * 60 * 1000; // expires in 5 minutes

  // Store in memory
  activeOtps.set(normalizedEmail, { otp, expiresAt });

  // Send OTP via Brevo
  const emailHtml = `
    <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 25px; border: 1px solid #e2e8f0; border-radius: 12px; background-color: #ffffff;">
      <h2 style="color: #2563eb; margin: 0 0 15px 0;">Admin Portal Verification</h2>
      <p>Hello,</p>
      <p>You requested access to the Aadhira Solutions Hackathon Admin Panel. Please use the following One-Time Password (OTP) to complete your login:</p>
      <div style="background-color: #eff6ff; border: 1px dashed #2563eb; padding: 15px; text-align: center; font-size: 24px; font-weight: bold; color: #1e40af; border-radius: 8px; letter-spacing: 5px; margin: 20px 0;">
        ${otp}
      </div>
      <p style="color: #dc2626; font-size: 12px;">This OTP is valid for 5 minutes. If you did not request this code, please ignore this email.</p>
      <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 20px 0;" />
      <p style="color: #94a3b8; font-size: 11px; text-align: center;">&copy; 2026 Aadhira Solutions. All rights reserved.</p>
    </div>
  `;

  const emailRes = await sendBrevoEmail({
    toEmail: normalizedEmail,
    toName: 'Hackathon Admin',
    subject: 'Hackathon Admin Portal OTP Code',
    htmlContent: emailHtml
  });

  if (emailRes.mock || emailRes.success) {
    return reply.send({ success: true, message: 'OTP has been successfully sent to your email.' });
  } else {
    return reply.status(500).send({ success: false, error: 'Failed to send OTP email via Brevo.' });
  }
});

// 0.5. Auth: Verify OTP
fastify.post('/api/auth/verify-otp', async (request, reply) => {
  const { email, otp } = request.body || {};
  if (!email || !otp) {
    return reply.status(400).send({ success: false, error: 'Email and OTP are required.' });
  }

  const normalizedEmail = email.trim().toLowerCase();
  const record = activeOtps.get(normalizedEmail);

  if (!record) {
    return reply.status(400).send({ success: false, error: 'No OTP record found. Please request a new code.' });
  }

  if (Date.now() > record.expiresAt) {
    activeOtps.delete(normalizedEmail);
    return reply.status(400).send({ success: false, error: 'OTP has expired. Please request a new code.' });
  }

  if (record.otp !== otp.trim()) {
    return reply.status(400).send({ success: false, error: 'Invalid OTP code. Please try again.' });
  }

  // Clear OTP on successful verify
  activeOtps.delete(normalizedEmail);

  // Generate Session Token
  const crypto = require('crypto');
  const sessionToken = crypto.randomBytes(32).toString('hex');
  activeSessions.add(sessionToken);

  return reply.send({ success: true, token: sessionToken });
});

// Auth: Send OTP for Registration (Duplicate Check + OTP Gen)
fastify.post('/api/register/send-otp', async (request, reply) => {
  const { email } = request.body || {};
  if (!email || email.trim() === '') {
    return reply.status(400).send({ success: false, error: 'Email address is required.' });
  }

  const normalizedEmail = email.trim().toLowerCase();

  try {
    // 1. Check if email is already registered in the DB
    const checkRes = await pool.query(
      'SELECT id FROM registrations WHERE LOWER(leader_email) = $1',
      [normalizedEmail]
    );

    if (checkRes.rows.length > 0) {
      return reply.status(400).send({
        success: false,
        error: 'This email address is already registered. Duplicate registrations are not allowed.'
      });
    }

    // 2. Generate 6-digit numeric OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + 5 * 60 * 1000; // expires in 5 minutes

    // 3. Store OTP in memory
    registrationOtps.set(normalizedEmail, { otp, expiresAt });

    // 4. Send OTP email via Brevo
    const emailHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 25px; border: 1px solid #e2e8f0; border-radius: 12px; background-color: #ffffff;">
        <h2 style="color: #2563eb; margin: 0 0 15px 0;">Email Verification</h2>
        <p>Hello,</p>
        <p>Thank you for starting your team registration for the Aadhira Solutions Hackathon. Please use the following One-Time Password (OTP) to verify your email address:</p>
        <div style="background-color: #eff6ff; border: 1px dashed #2563eb; padding: 15px; text-align: center; font-size: 24px; font-weight: bold; color: #1e40af; border-radius: 8px; letter-spacing: 5px; margin: 20px 0;">
          ${otp}
        </div>
        <p style="color: #dc2626; font-size: 12px;">This OTP is valid for 5 minutes. If you did not request this, please ignore this email.</p>
        <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 20px 0;" />
        <p style="color: #94a3b8; font-size: 11px; text-align: center;">&copy; 2026 Aadhira Solutions. All rights reserved.</p>
      </div>
    `;

    const emailRes = await sendBrevoEmail({
      toEmail: normalizedEmail,
      toName: 'Team Leader',
      subject: 'Aadhira Solutions Hackathon Email Verification Code',
      htmlContent: emailHtml
    });

    if (emailRes.mock || emailRes.success) {
      return reply.send({ success: true, message: 'OTP has been successfully sent to your email.' });
    } else {
      // Check if error indicates daily email limit exceeded
      const errStr = JSON.stringify(emailRes.error || '').toLowerCase();
      if (errStr.includes('limit') || errStr.includes('quota') || errStr.includes('exceed') || errStr.includes('susp')) {
        return reply.status(429).send({ 
          success: false, 
          code: 'LIMIT_EXCEEDED', 
          error: "Today's registration limit has been completed. Please come back tomorrow!" 
        });
      }
      return reply.status(500).send({ success: false, error: 'Failed to send verification email. Please try again.' });
    }
  } catch (err) {
    fastify.log.error('Duplicate registration check error:', err);
    return reply.status(500).send({ success: false, error: 'Internal database error.' });
  }
});

// Auth: Verify Registration OTP
fastify.post('/api/register/verify-otp', async (request, reply) => {
  const { email, otp } = request.body || {};
  if (!email || !otp) {
    return reply.status(400).send({ success: false, error: 'Email and OTP are required.' });
  }

  const normalizedEmail = email.trim().toLowerCase();
  const record = registrationOtps.get(normalizedEmail);

  if (!record) {
    return reply.status(400).send({ success: false, error: 'No OTP record found. Please request a new code.' });
  }

  if (Date.now() > record.expiresAt) {
    registrationOtps.delete(normalizedEmail);
    return reply.status(400).send({ success: false, error: 'OTP has expired. Please request a new code.' });
  }

  if (record.otp !== otp.trim()) {
    return reply.status(400).send({ success: false, error: 'Invalid OTP code. Please try again.' });
  }

  // Clear OTP and save verification status
  registrationOtps.delete(normalizedEmail);
  verifiedRegistrationEmails.add(normalizedEmail);

  return reply.send({ success: true, message: 'Email verified successfully.' });
});

// 1. Submit Registration Form (Public)
fastify.post('/api/register', async (request, reply) => {
  const parts = request.parts();
  const fields = {};

  try {
    for await (const part of parts) {
      if (part.file) {
        // Accumulate file into memory Buffer
        const fileBuffer = await concatStream(part.file);
        fields.payment_proof_data = fileBuffer;
        fields.payment_proof_mime = part.mimetype;
      } else {
        // Handle normal form field
        fields[part.fieldname] = part.value;
      }
    }
  } catch (err) {
    fastify.log.error(err);
    return reply.status(400).send({ success: false, error: 'File upload failed. Max size is 2MB.' });
  }

  // Validation
  const required = [
    'team_name', 'college_name', 'leader_name', 'leader_email', 'leader_phone',
    'member2_name', 'member2_phone', 'member3_name', 'member3_phone',
    'member4_name', 'member4_phone', 'problem_statement'
  ];

  for (const req of required) {
    if (!fields[req] || fields[req].trim() === '') {
      return reply.status(400).send({ success: false, error: `Field "${req}" is required.` });
    }
  }

  // Enforce that email is verified via OTP
  const normalizedLeaderEmail = fields.leader_email ? fields.leader_email.trim().toLowerCase() : '';
  if (!verifiedRegistrationEmails.has(normalizedLeaderEmail)) {
    return reply.status(400).send({ success: false, error: 'Email verification is required. Please verify your email via the OTP code before submitting.' });
  }

  if (!fields.payment_proof_data) {
    return reply.status(400).send({ success: false, error: 'Payment proof screenshot is required.' });
  }

  // Insert into DB (Blob BYTEA support)
  const queryText = `
    INSERT INTO registrations (
      team_name, college_name, leader_name, leader_email, leader_phone,
      member2_name, member2_phone, member3_name, member3_phone,
      member4_name, member4_phone, problem_statement, payment_proof_data, payment_proof_mime
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
    RETURNING id, team_name, college_name, leader_name, leader_email, leader_phone, status, created_at;
  `;

  const values = [
    fields.team_name, fields.college_name, fields.leader_name, fields.leader_email, fields.leader_phone,
    fields.member2_name, fields.member2_phone, fields.member3_name, fields.member3_phone,
    fields.member4_name, fields.member4_phone, fields.problem_statement,
    fields.payment_proof_data, fields.payment_proof_mime
  ];

  try {
    const res = await pool.query(queryText, values);
    const newReg = res.rows[0];
    
    // Clear verification state on successful registration
    verifiedRegistrationEmails.delete(normalizedLeaderEmail);
    
    return reply.status(201).send({ success: true, registration: newReg });
  } catch (err) {
    fastify.log.error('DB Insert Error:', err);
    return reply.status(500).send({ success: false, error: 'Database error occurred during registration.' });
  }
});

// 2. Fetch Registration details (Public status query - Exclude BYTEA data for performance)
fastify.get('/api/registration/:id', async (request, reply) => {
  const { id } = request.params;
  try {
    const res = await pool.query(
      'SELECT id, team_name, college_name, leader_name, leader_email, leader_phone, member2_name, member2_phone, member3_name, member3_phone, member4_name, member4_phone, problem_statement, status, attended, attended_at, created_at FROM registrations WHERE id = $1',
      [id]
    );
    if (res.rows.length === 0) {
      return reply.status(404).send({ success: false, error: 'Registration not found' });
    }
    return reply.send({ success: true, registration: res.rows[0] });
  } catch (err) {
    fastify.log.error(err);
    return reply.status(500).send({ success: false, error: 'Database query error' });
  }
});

// 3. Serve Payment Proof Image BLOB from DB
fastify.get('/api/registration/:id/proof', async (request, reply) => {
  const { id } = request.params;
  try {
    const res = await pool.query('SELECT payment_proof_data, payment_proof_mime FROM registrations WHERE id = $1', [id]);
    if (res.rows.length === 0 || !res.rows[0].payment_proof_data) {
      return reply.status(404).send({ success: false, error: 'Payment proof not found' });
    }
    const img = res.rows[0];
    reply.type(img.payment_proof_mime);
    return reply.send(img.payment_proof_data);
  } catch (err) {
    fastify.log.error(err);
    return reply.status(500).send({ success: false, error: 'Database query error' });
  }
});

// 4. Admin: Fetch all registrations with search & status filters (Exclude BYTEA data for performance)
fastify.get('/api/registrations', async (request, reply) => {
  await verifyAdminSession(request, reply);
  const { search, status } = request.query;
  let queryText = 'SELECT id, team_name, college_name, leader_name, leader_email, leader_phone, member2_name, member2_phone, member3_name, member3_phone, member4_name, member4_phone, problem_statement, status, attended, attended_at, created_at FROM registrations';
  const queryParams = [];
  const whereClauses = [];

  if (status) {
    queryParams.push(status);
    whereClauses.push(`status = $${queryParams.length}`);
  }

  if (search) {
    queryParams.push(`%${search}%`);
    const searchIndex = queryParams.length;
    whereClauses.push(`(
      team_name ILIKE $${searchIndex} OR
      college_name ILIKE $${searchIndex} OR
      leader_name ILIKE $${searchIndex} OR
      leader_email ILIKE $${searchIndex} OR
      leader_phone ILIKE $${searchIndex} OR
      problem_statement ILIKE $${searchIndex}
    )`);
  }

  if (whereClauses.length > 0) {
    queryText += ' WHERE ' + whereClauses.join(' AND ');
  }

  queryText += ' ORDER BY id DESC';

  try {
    const res = await pool.query(queryText, queryParams);
    return reply.send({ success: true, registrations: res.rows });
  } catch (err) {
    fastify.log.error(err);
    return reply.status(500).send({ success: false, error: 'Database search error' });
  }
});

// 5. Admin: Update Registration Status (Approve/Reject) + Send Brevo Email
fastify.patch('/api/registration/:id/status', async (request, reply) => {
  await verifyAdminSession(request, reply);
  const { id } = request.params;
  const { status } = request.body || {}; // 'Approved' or 'Rejected'

  if (!['Approved', 'Rejected'].includes(status)) {
    return reply.status(400).send({ success: false, error: 'Invalid status. Must be Approved or Rejected.' });
  }

  try {
    // 1. Fetch details first
    const findRes = await pool.query('SELECT id, team_name, college_name, leader_name, leader_email, leader_phone, member2_name, member2_phone, member3_name, member3_phone, member4_name, member4_phone, problem_statement FROM registrations WHERE id = $1', [id]);
    if (findRes.rows.length === 0) {
      return reply.status(404).send({ success: false, error: 'Registration not found' });
    }
    const team = findRes.rows[0];

    // 2. Update status in database
    const updateRes = await pool.query(
      'UPDATE registrations SET status = $1 WHERE id = $2 RETURNING id, status',
      [status, id]
    );
    const updatedTeam = updateRes.rows[0];

    // 3. Send email to Team Leader
    const host = request.headers.host;
    const protocol = request.headers['x-forwarded-proto'] || 'http';
    const verifyUrl = `${protocol}://${host}/verify.html?id=${team.id}`;
    const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=170x170&color=0b0f19&bgcolor=ffffff&data=${encodeURIComponent(verifyUrl)}`;

    let emailSubject = '';
    let emailHtmlContent = '';

    if (status === 'Approved') {
      emailSubject = `Hackathon Registration Approved! Team ID: ${team.id} - Aadhira Solutions`;
      emailHtmlContent = `
        <div style="font-family: 'Outfit', sans-serif, Arial; max-width: 600px; margin: 0 auto; padding: 25px; border-radius: 12px; background-color: #0b0f19; color: #f8fafc; border: 1px solid #1e293b;">
          <div style="text-align: center; margin-bottom: 25px;">
            <h1 style="color: #10b981; font-size: 24px; margin-top: 10px;">Aadhira Solutions Hackathon</h1>
            <p style="color: #94a3b8; font-size: 14px;">Project Team Registration & Problem Selection</p>
          </div>
          
          <div style="background-color: #1e293b; padding: 20px; border-radius: 8px; margin-bottom: 25px; border-left: 4px solid #10b981;">
            <h2 style="margin-top: 0; color: #10b981; font-size: 18px;">Registration Approved!</h2>
            <p style="font-size: 15px; line-height: 1.6; color: #e2e8f0;">
              Congratulations, <strong>${team.leader_name}</strong>! Your team's registration for the Aadhira Solutions Hackathon has been verified and approved.
            </p>
            <p style="font-size: 16px; margin-bottom: 5px; color: #f1f5f9;"><strong>Assigned Team ID:</strong> <span style="background-color: #0f172a; padding: 3px 8px; border-radius: 4px; color: #10b981; font-weight: bold; border: 1px solid #10b981;">${team.id}</span></p>
            <p style="font-size: 14px; color: #cbd5e1; margin-top: 5px;"><strong>College:</strong> ${team.college_name}</p>
            <p style="font-size: 14px; color: #cbd5e1; margin-top: 5px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;"><strong>Problem:</strong> ${team.problem_statement}</p>
          </div>
          
          <div style="text-align: center; background-color: #0f172a; padding: 20px; border-radius: 8px; margin-bottom: 25px; border: 1px solid #1e293b;">
            <p style="margin-top: 0; font-size: 15px; font-weight: bold; color: #f1f5f9;">Your Official Entry QR Code</p>
            <p style="font-size: 13px; color: #94a3b8; margin-bottom: 15px;">Please show this QR code at the venue registration desk for attendance verification.</p>
            <img src="${qrImageUrl}" alt="Verification QR Code" style="border: 4px solid #ffffff; border-radius: 8px; margin: 0 auto; display: block;" width="170" height="170" />
          </div>

          <div style="margin-bottom: 25px;">
            <h3 style="color: #10b981; font-size: 16px; margin-bottom: 10px;">Team Lineup:</h3>
            <ul style="padding-left: 20px; color: #cbd5e1; font-size: 14px; line-height: 1.6;">
              <li><strong>Leader:</strong> ${team.leader_name} (${team.leader_phone})</li>
              <li><strong>Member 2:</strong> ${team.member2_name} (${team.member2_phone})</li>
              <li><strong>Member 3:</strong> ${team.member3_name} (${team.member3_phone})</li>
              <li><strong>Member 4:</strong> ${team.member4_name} (${team.member4_phone})</li>
            </ul>
          </div>
          
          <hr style="border: 0; border-top: 1px solid #1e293b; margin: 25px 0;" />
          
          <div style="text-align: center; color: #64748b; font-size: 12px; line-height: 1.5;">
            <p>This is an automated notification. Please do not reply directly to this email.</p>
            <p>&copy; 2026 Aadhira Solutions. All rights reserved.</p>
          </div>
        </div>
      `;
    } else {
      emailSubject = `Hackathon Registration Update - Action Required - Aadhira Solutions`;
      emailHtmlContent = `
        <div style="font-family: 'Outfit', sans-serif, Arial; max-width: 600px; margin: 0 auto; padding: 25px; border-radius: 12px; background-color: #0b0f19; color: #f8fafc; border: 1px solid #1e293b;">
          <div style="text-align: center; margin-bottom: 25px;">
            <h1 style="color: #ef4444; font-size: 24px; margin-top: 10px;">Aadhira Solutions Hackathon</h1>
            <p style="color: #94a3b8; font-size: 14px;">Project Team Registration & Problem Selection</p>
          </div>
          
          <div style="background-color: #1e293b; padding: 20px; border-radius: 8px; margin-bottom: 25px; border-left: 4px solid #ef4444;">
            <h2 style="margin-top: 0; color: #ef4444; font-size: 18px;">Registration Rejected / Needs Verification</h2>
            <p style="font-size: 15px; line-height: 1.6; color: #e2e8f0;">
              Hello <strong>${team.leader_name}</strong>,
            </p>
            <p style="font-size: 15px; line-height: 1.6; color: #e2e8f0;">
              We reviewed your registration and could not verify your payment screenshot. It might be blurry, incorrect, or incomplete.
            </p>
            <p style="font-size: 15px; line-height: 1.6; color: #e2e8f0;">
              Please re-register at our website with the correct payment screenshot of 400 rupees (100 rupees per person) to successfully verify your entry.
            </p>
          </div>
          
          <div style="text-align: center;">
            <a href="${protocol}://${host}/" style="display: inline-block; padding: 12px 24px; background-color: #ef4444; color: #ffffff; text-decoration: none; border-radius: 6px; font-weight: bold;">Register Again</a>
          </div>
          
          <hr style="border: 0; border-top: 1px solid #1e293b; margin: 25px 0;" />
          
          <div style="text-align: center; color: #64748b; font-size: 12px; line-height: 1.5;">
            <p>If you believe this is a mistake, please reach out to the hackathon coordinator.</p>
            <p>&copy; 2026 Aadhira Solutions. All rights reserved.</p>
          </div>
        </div>
      `;
    }

    // Call Brevo API with QR code attachment if approved
    let attachment;
    if (status === 'Approved') {
      try {
        const qrRes = await fetch(qrImageUrl);
        const qrBuffer = await qrRes.arrayBuffer();
        attachment = [
          {
            content: Buffer.from(qrBuffer).toString('base64'),
            name: `team_${team.id}_entry_qr.png`
          }
        ];
      } catch (err) {
        fastify.log.error('Failed to fetch QR code for attachment:', err);
      }
    }

    await sendBrevoEmail({
      toEmail: team.leader_email,
      toName: team.leader_name,
      subject: emailSubject,
      htmlContent: emailHtmlContent,
      attachment
    });

    return reply.send({ success: true, registration: updatedTeam });
  } catch (err) {
    fastify.log.error(err);
    return reply.status(500).send({ success: false, error: 'Database update error' });
  }
});

// 6. Public/QR Scan: Mark registration as Attended
fastify.post('/api/registration/:id/attend', async (request, reply) => {
  const { id } = request.params;

  try {
    // Check if team exists and is approved
    const findRes = await pool.query('SELECT status FROM registrations WHERE id = $1', [id]);
    if (findRes.rows.length === 0) {
      return reply.status(404).send({ success: false, error: 'Registration not found' });
    }

    const team = findRes.rows[0];
    if (team.status !== 'Approved') {
      return reply.status(400).send({ success: false, error: 'Cannot check-in a registration that has not been approved.' });
    }

    // Update status
    const updateRes = await pool.query(
      'UPDATE registrations SET attended = TRUE, attended_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING id, attended, attended_at',
      [id]
    );

    return reply.send({ success: true, registration: updateRes.rows[0] });
  } catch (err) {
    fastify.log.error(err);
    return reply.status(500).send({ success: false, error: 'Database update error' });
  }
});

// 7. Admin: Get Stats
fastify.get('/api/stats', async (request, reply) => {
  await verifyAdminSession(request, reply);
  try {
    // Run multiple stats queries in parallel
    const [totalRes, pendingRes, approvedRes, rejectedRes, attendedRes, problemStats] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM registrations'),
      pool.query("SELECT COUNT(*) FROM registrations WHERE status = 'Pending'"),
      pool.query("SELECT COUNT(*) FROM registrations WHERE status = 'Approved'"),
      pool.query("SELECT COUNT(*) FROM registrations WHERE status = 'Rejected'"),
      pool.query('SELECT COUNT(*) FROM registrations WHERE attended = TRUE'),
      pool.query('SELECT problem_statement, COUNT(*) FROM registrations GROUP BY problem_statement')
    ]);

    const totalCount = parseInt(totalRes.rows[0].count);
    const pendingCount = parseInt(pendingRes.rows[0].count);
    const approvedCount = parseInt(approvedRes.rows[0].count);
    const rejectedCount = parseInt(rejectedRes.rows[0].count);
    const attendedCount = parseInt(attendedRes.rows[0].count);

    // Calculate revenue: 100 rupees per person.
    const revenueRes = await pool.query(`
      SELECT SUM(
        1 + 
        CASE WHEN TRIM(member2_name) <> '' THEN 1 ELSE 0 END +
        CASE WHEN TRIM(member3_name) <> '' THEN 1 ELSE 0 END +
        CASE WHEN TRIM(member4_name) <> '' THEN 1 ELSE 0 END
      ) * 100 AS revenue
      FROM registrations
      WHERE status = 'Approved'
    `);
    
    const revenue = parseInt(revenueRes.rows[0].revenue || 0);

    return reply.send({
      success: true,
      stats: {
        total: totalCount,
        pending: pendingCount,
        approved: approvedCount,
        rejected: rejectedCount,
        attended: attendedCount,
        revenue: revenue,
        problemDistribution: problemStats.rows
      }
    });
  } catch (err) {
    fastify.log.error(err);
    return reply.status(500).send({ success: false, error: 'Failed to retrieve stats' });
  }
});

// 8. Public: Submit Support Ticket
fastify.post('/api/tickets', async (request, reply) => {
  const { name, email, message } = request.body || {};
  if (!name || !email || !message) {
    return reply.status(400).send({ success: false, error: 'Name, email, and message are required.' });
  }

  const normalizedEmail = email.trim().toLowerCase();

  try {
    const checkRes = await pool.query('SELECT id FROM registrations WHERE LOWER(leader_email) = $1', [normalizedEmail]);
    if (checkRes.rows.length === 0) {
      return reply.status(400).send({ success: false, error: 'Email not found in registered teams.' });
    }

    await pool.query(
      'INSERT INTO tickets (name, leader_email, message) VALUES ($1, $2, $3)',
      [name.trim(), normalizedEmail, message.trim()]
    );
    return reply.status(201).send({ success: true, message: 'Ticket submitted successfully.' });
  } catch (err) {
    fastify.log.error('Ticket Insert Error:', err);
    return reply.status(500).send({ success: false, error: 'Database error occurred while submitting ticket.' });
  }
});

// 9. Admin: Get all tickets
fastify.get('/api/admin/tickets', async (request, reply) => {
  await verifyAdminSession(request, reply);
  try {
    const res = await pool.query(`
      SELECT t.*, r.leader_phone, r.team_name
      FROM tickets t
      LEFT JOIN registrations r ON LOWER(r.leader_email) = t.leader_email
      ORDER BY t.created_at DESC
    `);
    return reply.send({ success: true, tickets: res.rows });
  } catch (err) {
    fastify.log.error('Ticket Fetch Error:', err);
    return reply.status(500).send({ success: false, error: 'Database search error' });
  }
});

// 10. Admin: Update ticket status
fastify.put('/api/admin/tickets/:id/status', async (request, reply) => {
  await verifyAdminSession(request, reply);
  const { id } = request.params;
  const { status } = request.body || {};
  if (!status) return reply.status(400).send({ success: false, error: 'Status is required' });

  try {
    const res = await pool.query('UPDATE tickets SET status = $1 WHERE id = $2 RETURNING *', [status, id]);
    if (res.rows.length === 0) {
      return reply.status(404).send({ success: false, error: 'Ticket not found' });
    }
    return reply.send({ success: true, ticket: res.rows[0] });
  } catch (err) {
    fastify.log.error('Ticket Update Error:', err);
    return reply.status(500).send({ success: false, error: 'Database update error' });
  }
});

// Start the server
const start = async () => {
  try {
    await initDb();
    await fastify.listen({ port: PORT, host: HOST });
    fastify.log.info(`Server listening on http://localhost:${PORT}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
