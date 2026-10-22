// How an IMAP or connection failure is recognised and put into words. Pure functions over the error, no connection state.

function collectErrorText(error: unknown): string {
  const values: string[] = [];

  if (error instanceof Error) {
    values.push(error.message);
    values.push(error.name);
    const maybeResponseText = (error as { responseText?: unknown }).responseText;
    if (typeof maybeResponseText === "string") {
      values.push(maybeResponseText);
    }
    const maybeCode = (error as { code?: unknown }).code;
    if (typeof maybeCode === "string") {
      values.push(maybeCode);
    }
  } else if (typeof error === "string") {
    values.push(error);
  } else if (typeof error === "object" && error !== null) {
    const maybeMessage = (error as { message?: unknown }).message;
    const maybeCode = (error as { code?: unknown }).code;
    const maybeResponse = (error as { response?: unknown }).response;
    if (typeof maybeMessage === "string") {
      values.push(maybeMessage);
    }
    if (typeof maybeCode === "string") {
      values.push(maybeCode);
    }
    if (typeof maybeResponse === "string") {
      values.push(maybeResponse);
    }
  }

  return values.join(" ").toLowerCase();
}

// imapflow throws a generic Error("Command failed") for every IMAP NO/BAD
// response (mailbox create/rename/delete, move, flag change, ...) — the
// server's actual reason (e.g. Bridge rejecting a reserved folder name)
// lives in the non-standard `.responseText` property, never in `.message`.
// Left alone, every one of these surfaces as an unhelpful "Command failed"
// with no clue why. Surface both. Found live: create_label "Starred" failed
// with just "Command failed" instead of Bridge's actual rejection reason.
export function describeImapError(error: unknown): string | undefined {
  if (!(error instanceof Error) || !error.message) {
    return undefined;
  }
  const responseText = (error as { responseText?: unknown }).responseText;
  if (typeof responseText === "string" && responseText.trim() && !error.message.includes(responseText.trim())) {
    return `${error.message}: ${responseText.trim()}`;
  }
  return error.message;
}

export function isLikelyAuthenticationError(error: unknown): boolean {
  if (!error) {
    return false;
  }

  const haystack = collectErrorText(error);
  if (!haystack) {
    return false;
  }

  return [
    "auth",
    "login failed",
    "incorrect login credentials",
    "invalid credentials",
    "authentication failed",
    "no such user",
    "too many login attempts",
  ].some((needle) => haystack.includes(needle));
}

// Distinguishes "Bridge isn't running / wrong host-port" from other failures, so the
// caller can point the user at Bridge instead of a generic "internal error occurred".
// A TLS handshake attempted against a plaintext/STARTTLS-only port (or the
// reverse — plaintext against an implicit-TLS port, though that direction
// more often just surfaces as a bare ECONNRESET, already covered by
// isLikelyConnectionError, and can't be reliably told apart from a genuinely
// unreachable Bridge from the error text alone) surfaces as Node/OpenSSL's
// own EPROTO error. Neither isLikelyAuthenticationError nor
// isLikelyConnectionError matched this, so a PROTONMAIL_*_SECURE/port
// mismatch (Bridge assigns essentially random ports per install — confirmed
// live) produced a bare "connection failed" with zero diagnosis, despite
// run_doctor's own description promising a classified cause for every
// connection failure.
export function isLikelyTlsMismatchError(error: unknown): boolean {
  if (!error) {
    return false;
  }

  const haystack = collectErrorText(error);
  if (!haystack) {
    return false;
  }

  return ["eproto", "wrong version number", "ssl routines", "wrong_version_number"].some((needle) =>
    haystack.includes(needle),
  );
}

// A certificate Node does not trust: Bridge's own is self-signed, so a host reached by another name than localhost
// fails this way until the certificate is pinned (PROTONMAIL_TLS_CA_FILE) or the host is listed.
export function isLikelyCertificateError(error: unknown): boolean {
  if (!error) {
    return false;
  }
  const haystack = collectErrorText(error);
  if (!haystack) {
    return false;
  }
  return [
    "self-signed certificate",
    "self signed certificate",
    "depth_zero_self_signed_cert",
    "unable to verify the first certificate",
    "unable_to_verify_leaf_signature",
    "unable to get local issuer certificate",
    "certificate has expired",
    "err_tls_cert_altname_invalid",
    "does not match certificate",
  ].some((needle) => haystack.includes(needle));
}

export function isLikelyConnectionError(error: unknown): boolean {
  if (!error) {
    return false;
  }

  const haystack = collectErrorText(error);
  if (!haystack) {
    return false;
  }

  return [
    "econnrefused",
    "enotfound",
    "etimedout",
    "ehostunreach",
    "econnreset",
    "connect etimedout",
    "connection closed",
    "connection timed out",
    "timed out while connecting",
  ].some((needle) => haystack.includes(needle));
}
