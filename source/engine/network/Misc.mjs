/**
 * @param {string} ip IP address
 * @param {number} port port number
 * @returns {string} formatted IP address with port
 */
export function formatIP(ip, port) {
  return ip.includes(':') ? `[${ip}]:${port}` : `${ip}:${port}`;
};
