// Site-wide settings that are not content. Content lives in ./data/*.json.

export const EMAIL = 'nguyenson.0312vn@gmail.com';
export const PHONE = '0946831748';

// Intro showreel: indexes into videos.json; the center one (3rd) autoplays.
export const DECK_IDS = [13, 0, 17, 49, 31];

// Chapters not built yet show as hatched blocks at the end of the timeline.
export const GHOSTS = [];
// Share of the bottom timeline that maps to the scrollable page; the rest is for GHOSTS.
export const BUILT = GHOSTS.length ? 0.86 : 1;

// Cloudinary account that hosts the videos.
const CLD = 'https://res.cloudinary.com/dlztimgay/video/upload/';
// 3:4 crops; app.js picks h from a few fixed sizes to match the card's on-screen height
export const thumbURL   = (id, h = 720) => `${CLD}c_fill,w_${h * 3 / 4},h_${h},q_auto:good,f_jpg/${id}.jpg`;
// the uncropped size the old site used; always cached, used when a cropped size fails to load
export const fallbackThumbURL = id => `${CLD}w_900,q_auto,f_jpg/${id}.jpg`;
export const previewURL = id => `${CLD}c_fill,w_480,h_640,q_auto,ac_none,du_8/${id}.mp4`;
export const metaURL    = id => `${CLD}w_64,q_auto,f_jpg/${id}.jpg`;
export const embedURL   = id => `https://player.cloudinary.com/embed/?cloud_name=dlztimgay&public_id=${id}&player[autoplay]=true&player[controls]=true`;
