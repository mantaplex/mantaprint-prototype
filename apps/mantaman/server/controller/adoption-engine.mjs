import crypto from 'node:crypto';
import EventEmitter from 'node:events';

export class AdoptionEngine extends EventEmitter {
  constructor(store) {
    super();
    this.store = store;
    this.activeChallenges = new Map(); // hubId -> { pin, exp, attempts }
  }

  // Generate ephemeral 6-digit challenge PIN for zero-touch physical pairing
  generateChallengePin(hubId) {
    const pin = String(crypto.randomInt(100000, 1000000));
    const exp = Date.now() + 300000; // 5 minutes TTL
    this.activeChallenges.set(hubId, { pin, exp, attempts: 0 });
    this.store.setPairingChallenge(hubId, pin, 300000);
    return { pin, exp };
  }

  // Attempt to adopt a hub using PIN or Admin Credential
  async adoptHub({ hubId, pin, siteId, customName, actor = 'admin', forceAdopt = false }) {
    const hub = this.store.getHub(hubId);
    if (!hub) {
      throw new Error(`Hub '${hubId}' not found in discovery registry.`);
    }

    if (hub.status === 'managed') {
      throw new Error(`Hub '${hubId}' is already managed.`);
    }

    // Verify PIN if challenge was generated or if PIN provided (unless forceAdopt is true)
    const challenge = this.activeChallenges.get(hubId) || (hub.pairing_pin ? { pin: hub.pairing_pin, exp: hub.pairing_pin_exp, attempts: 0 } : null);
    if (!forceAdopt && challenge && challenge.pin) {
      if (!pin || typeof pin !== 'string') {
        throw new Error('Pairing challenge PIN is required to adopt this Hub.');
      }
      if (Date.now() > challenge.exp) {
        this.activeChallenges.delete(hubId);
        throw new Error('Pairing challenge PIN has expired. Please generate a new one.');
      }
      if (challenge.attempts >= 5) {
        this.activeChallenges.delete(hubId);
        throw new Error('Too many invalid pairing attempts. Challenge locked.');
      }

      const providedPinBuf = Buffer.from(pin.trim());
      const expectedPinBuf = Buffer.from(challenge.pin);
      const isMatch = providedPinBuf.length === expectedPinBuf.length && crypto.timingSafeEqual(providedPinBuf, expectedPinBuf);

      if (!isMatch) {
        challenge.attempts = (challenge.attempts || 0) + 1;
        this.activeChallenges.set(hubId, challenge);
        throw new Error(`Invalid pairing PIN. (${5 - challenge.attempts} attempts remaining).`);
      }
    }

    // Generate secure capability token
    const rawToken = 'mp_flt_' + crypto.randomBytes(24).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

    // Adopt in Store
    const updatedHub = this.store.adoptHub(hubId, {
      site_id: siteId || 'site_default',
      name: customName || hub.name,
      token_hash: tokenHash
    });

    this.activeChallenges.delete(hubId);

    // Audit Log
    this.store.recordAuditLog({
      actor,
      action: 'adopt_hub',
      target_type: 'hub',
      target_id: hubId,
      details: { site_id: siteId, name: updatedHub.name }
    });

    this.emit('hub_adopted', {
      hubId,
      authToken: rawToken,
      hub: updatedHub
    });

    return {
      hub: updatedHub,
      auth_token: rawToken
    };
  }

  // Verify capability token incoming from Hub agent
  verifyHubToken(hubId, token) {
    if (!token) return false;
    const hub = this.store.getHub(hubId);
    if (!hub || !hub.auth_token_hash) return false;

    const providedHash = crypto.createHash('sha256').update(token).digest('hex');
    try {
      return crypto.timingSafeEqual(Buffer.from(providedHash), Buffer.from(hub.auth_token_hash));
    } catch {
      return false;
    }
  }

  // Unadopt / Revoke Hub from fleet management
  unadoptHub(hubId, actor = 'admin') {
    const hub = this.store.getHub(hubId);
    if (!hub) throw new Error('Hub not found');

    this.activeChallenges.delete(hubId);
    const unadopted = this.store.unadoptHub(hubId);

    this.store.recordAuditLog({
      actor,
      action: 'unadopt_hub',
      target_type: 'hub',
      target_id: hubId,
      details: { previous_site: hub.site_id, previous_name: hub.name }
    });

    return unadopted;
  }
}
