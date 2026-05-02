const fs = require('fs');

const mappings = {
  'hero_rider_blue_1777481440565.png': 'hero_rider.png',
  'food_restaurant_1777481457337.png': 'food_restaurant.png',
  'pharmacy_medicine_1777481476030.png': 'pharmacy_medicine.png',
  'send_parcel_1777481491852.png': 'send_parcel.png',
  'move_goods_1777481526530.png': 'move_goods.png'
};

for (const [src, dest] of Object.entries(mappings)) {
  fs.copyFileSync(`C:\\Users\\subha\\.gemini\\antigravity\\brain\\7f6164c1-fbef-454b-837a-5feac1d73577\\${src}`, `C:\\Users\\subha\\Desktop\\DESKTOP\\sandeep\\Zipto\\src\\assets\\images\\${dest}`);
}
console.log('Copied all new images');
