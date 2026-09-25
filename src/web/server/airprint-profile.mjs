/**
 * MantaPrint Hub - AirPrint configuration profile (.mobileconfig)
 */
import crypto from 'node:crypto';

// AirPrint configuration profile (.mobileconfig) for iPhone/iPad on networks where
// mDNS discovery is blocked: iOS cannot add an IPP printer by address, but it accepts
// a com.apple.airprint payload that points at the CUPS queue directly.
function xmlEscape(value) {
  return String(value).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

function stableUuid(seed) {
  const h = crypto.createHash('sha1').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`.toUpperCase();
}

export function buildAirPrintProfile({ ip, queue, name, hostname }) {
  const id = `local.${String(hostname || 'mantaprint').replace(/[^a-zA-Z0-9-]/g, '')}.airprint.${queue}`;
  const label = name || queue;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>AirPrint</key>
      <array>
        <dict>
          <key>ForceTLS</key>
          <false/>
          <key>IPAddress</key>
          <string>${xmlEscape(ip)}</string>
          <key>Port</key>
          <integer>631</integer>
          <key>ResourcePath</key>
          <string>printers/${xmlEscape(queue)}</string>
        </dict>
      </array>
      <key>PayloadDisplayName</key>
      <string>AirPrint: ${xmlEscape(label)}</string>
      <key>PayloadIdentifier</key>
      <string>${xmlEscape(id)}.printer</string>
      <key>PayloadType</key>
      <string>com.apple.airprint</string>
      <key>PayloadUUID</key>
      <string>${stableUuid(`${id}.printer`)}</string>
      <key>PayloadVersion</key>
      <integer>1</integer>
    </dict>
  </array>
  <key>PayloadDescription</key>
  <string>Adds ${xmlEscape(label)} on MantaPrint Hub (${xmlEscape(ip)}) to the printer list.</string>
  <key>PayloadDisplayName</key>
  <string>MantaPrint: ${xmlEscape(label)}</string>
  <key>PayloadIdentifier</key>
  <string>${xmlEscape(id)}</string>
  <key>PayloadRemovalDisallowed</key>
  <false/>
  <key>PayloadType</key>
  <string>Configuration</string>
  <key>PayloadUUID</key>
  <string>${stableUuid(id)}</string>
  <key>PayloadVersion</key>
  <integer>1</integer>
</dict>
</plist>
`;
}
