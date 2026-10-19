// Renames stickers/1.png..22.png to their canonical filenames in data/stickers.json
const fs = require('fs');
const path = require('path');

const stickersDir = path.join(__dirname, '..', 'stickers');

const map = [
  { from: '1.png', to: 'kevin_malone_smirk.png' },
  { from: '2.png', to: 'barney_stinson_loving_napkin_pouch.png' },
  { from: '3.png', to: 'ray_holt_confused_old_woman.png' },
  { from: '4.png', to: 'claire_dunphy_messy_hair_mug_scoff.png' },
  { from: '5.png', to: 'ed_truck_michael_scott_handshake_logo.png' },
  { from: '6.png', to: 'burhan_altintop_office_skincare_magazine.png' },
  { from: '7.png', to: 'chandler_bing_pink_bunny.png' },
  { from: '8.png', to: 'leonard_hofstadter_sarcasm_sign.png' },
  { from: '9.png', to: 'rachel_sleeping_under_comforter.png' },
  { from: '10.png', to: 'ferhunde_tekin_sobe_affair_photo.png' },
  { from: '11.png', to: 'ai_female_kitten_armored_sword_flat_face.png' },
  { from: '12.png', to: 'nurhayat_karakas_pajamas_reading_newspaper.png' },
  { from: '13.png', to: 'jake_peralta_this_is_killing_me.png' },
  { from: '14.png', to: 'michael_scott_animated_smirk.png' },
  { from: '15.png', to: 'joey_tribbiani_ok_sign_not_bad.png' },
  { from: '16.png', to: 'ali_riza_tekin_peeking_behind_door.png' },
  { from: '17.png', to: 'gina_linetti_blue_snuggie_sunglasses.png' },
  { from: '18.png', to: 'joey_tribbiani_late_realization_red_sweater.png' },
  { from: '19.png', to: 'ai_black_cat_dap_up.png' },
  { from: '20.png', to: 'ross_geller_apartment_window_triumph.png' },
  { from: '21.png', to: 'monica_geller_turkey_head_dance.png' },
  { from: '22.png', to: 'barney_stinson_umm_i_guess_palm.png' },
];

for (const { from, to } of map) {
  const src = path.join(stickersDir, from);
  const dst = path.join(stickersDir, to);
  if (fs.existsSync(src)) {
    fs.renameSync(src, dst);
    console.log(`Renamed: ${from} -> ${to}`);
  } else if (fs.existsSync(dst)) {
    console.log(`Already renamed: ${to}`);
  } else {
    console.warn(`Source file not found: ${from}`);
  }
}
