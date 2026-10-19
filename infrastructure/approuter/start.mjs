/**
 * Starts the approuter with one addition for the Fiori pages it forwards under
 * /sap/. The workspace's Content-Security-Policy (xs-app.json) is written for
 * the workspace's own pages: it would stop Fiori's scripts and forbids any
 * framing. Fiori pages get a policy of their own instead, with one rule: only
 * the workspace may frame them.
 */
import approuter from '@sap/approuter';

const FIORI_POLICY = "frame-ancestors 'self'";

const ar = approuter();
ar.beforeRequestHandler.use('/sap', (req, res, next) => {
  const writeHead = res.writeHead;
  res.writeHead = function (...args) {
    // Headers may also arrive as the last argument of writeHead; the policy set here must be the one that is sent.
    const headers = args.find((a) => a && typeof a === 'object' && !Array.isArray(a));
    if (headers) for (const name of Object.keys(headers)) if (name.toLowerCase() === 'content-security-policy') delete headers[name];
    res.setHeader('Content-Security-Policy', FIORI_POLICY);
    return writeHead.apply(this, args);
  };
  next();
});
ar.start();
