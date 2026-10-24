type Point = [number, number];
const radians = Math.PI / 180;
const a = 6378137, f = 1 / 298.257223563, b = a * (1 - f);

// Vincenty's inverse/direct formulae on WGS84. Prepared reaches contain short
// segments; cumulative distances come from the API's ellipsoidal geometry.
export function riverCoordinate(points: Point[], distances: number[], distance: number): Point {
  const end = Math.max(1, distances.findIndex(value => value >= distance));
  const index = distance >= distances[distances.length - 1] ? points.length - 2 : end - 1;
  const start = points[index], finish = points[index + 1];
  const offset = Math.max(0, Math.min(distances[index + 1] - distances[index], distance - distances[index]));
  if (offset === 0) return start;
  if (distance >= distances[distances.length - 1]) return points[points.length - 1];
  const u1 = Math.atan((1 - f) * Math.tan(start[1] * radians));
  const u2 = Math.atan((1 - f) * Math.tan(finish[1] * radians));
  const sinU1 = Math.sin(u1), cosU1 = Math.cos(u1), sinU2 = Math.sin(u2), cosU2 = Math.cos(u2);
  const delta = (finish[0] - start[0]) * radians;
  let lambda = delta;
  for (let iteration = 0; iteration < 50; iteration++) {
    const sinLambda = Math.sin(lambda), cosLambda = Math.cos(lambda);
    const sinSigma = Math.hypot(cosU2 * sinLambda, cosU1 * sinU2 - sinU1 * cosU2 * cosLambda);
    if (sinSigma === 0) return start;
    const cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosLambda;
    const sigma = Math.atan2(sinSigma, cosSigma);
    const sinAlpha = cosU1 * cosU2 * sinLambda / sinSigma;
    const cosSqAlpha = 1 - sinAlpha * sinAlpha;
    const cos2SigmaM = cosSqAlpha > 1e-15 ? cosSigma - 2 * sinU1 * sinU2 / cosSqAlpha : 0;
    const c = f / 16 * cosSqAlpha * (4 + f * (4 - 3 * cosSqAlpha));
    const next = delta + (1 - c) * f * sinAlpha * (sigma + c * sinSigma * (cos2SigmaM + c * cosSigma * (-1 + 2 * cos2SigmaM ** 2)));
    if (Math.abs(next - lambda) < 1e-14) { lambda = next; break; }
    lambda = next;
  }
  const bearing = Math.atan2(cosU2 * Math.sin(lambda), cosU1 * sinU2 - sinU1 * cosU2 * Math.cos(lambda));
  const sinBearing = Math.sin(bearing), cosBearing = Math.cos(bearing);
  const sigma1 = Math.atan2(Math.tan(u1), cosBearing);
  const sinAlpha = cosU1 * sinBearing, cosSqAlpha = 1 - sinAlpha ** 2;
  const uSq = cosSqAlpha * (a * a - b * b) / (b * b);
  const factorA = 1 + uSq / 16384 * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)));
  const factorB = uSq / 1024 * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)));
  let sigma = offset / (b * factorA);
  for (let iteration = 0; iteration < 50; iteration++) {
    const sinSigma = Math.sin(sigma), cosSigma = Math.cos(sigma), middle = Math.cos(2 * sigma1 + sigma);
    const correction = factorB * sinSigma * (middle + factorB / 4 * (cosSigma * (-1 + 2 * middle ** 2) - factorB / 6 * middle * (-3 + 4 * sinSigma ** 2) * (-3 + 4 * middle ** 2)));
    const next = offset / (b * factorA) + correction;
    if (Math.abs(next - sigma) < 1e-14) { sigma = next; break; }
    sigma = next;
  }
  const sinSigma = Math.sin(sigma), cosSigma = Math.cos(sigma);
  const temporary = sinU1 * sinSigma - cosU1 * cosSigma * cosBearing;
  const latitude = Math.atan2(sinU1 * cosSigma + cosU1 * sinSigma * cosBearing, (1 - f) * Math.hypot(sinAlpha, temporary));
  const longitude = Math.atan2(sinSigma * sinBearing, cosU1 * cosSigma - sinU1 * sinSigma * cosBearing);
  const c = f / 16 * cosSqAlpha * (4 + f * (4 - 3 * cosSqAlpha));
  const middle = Math.cos(2 * sigma1 + sigma);
  const correction = longitude - (1 - c) * f * sinAlpha * (sigma + c * sinSigma * (middle + c * cosSigma * (-1 + 2 * middle ** 2)));
  return [start[0] + correction / radians, latitude / radians];
}
