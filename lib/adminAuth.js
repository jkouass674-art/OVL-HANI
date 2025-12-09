// Middleware pour protéger l'accès admin par code
function adminAuth(req, res, next) {
  const code = req.query.code || req.body?.code;
  if (code === "200700") return next();
  res.status(403).send("Accès refusé : code incorrect.");
}

module.exports = adminAuth;
