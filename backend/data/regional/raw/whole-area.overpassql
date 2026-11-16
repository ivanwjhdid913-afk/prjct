[out:json][timeout:120];
area(3600072169)->.lipetsk;
rel(72169);
out meta geom;
(
  way(area.lipetsk)["waterway"~"^(river|stream)$"];
  way(area.lipetsk)["natural"="water"];
  rel(area.lipetsk)["natural"="water"];
  way(area.lipetsk)["water"~"^(lake|pond|reservoir)$"];
  rel(area.lipetsk)["water"~"^(lake|pond|reservoir)$"];
  way(area.lipetsk)["landuse"="reservoir"];
  rel(area.lipetsk)["landuse"="reservoir"];
)->.local;
.local out meta geom;
rel(bw.local)["type"="waterway"];
out meta;
