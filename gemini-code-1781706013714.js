const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const fs = require('fs');
const path = require('path');
const { initializeApp } = require('firebase/app');
const { getFirestore, doc, getDoc, setDoc, updateDoc, deleteDoc, collection, getDocs, onSnapshot, query, orderBy, where } = require('firebase/firestore');
const http = require('http'); // الحزمة الرسمية الخفيفة لإرسال نبضات الإيقاظ فورا

// 1. خدمة الـ Uptime لمنع وضع الغفوة واستقبال الرد السريع بكلمة OK فقط
const app = express();
app.get('/uptime', (req, res) => { 
    res.setHeader('Content-Type', 'text/plain');
    res.end('OK'); // رد فوري ومختصر جداً لزيادة السرعة
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🔒 الحارس المركزي شغال على منفذ: ${PORT}`);
    
    // 🛡️ حارس الإيقاظ التلقائي الذاتي (يوقظ السيرفر كل دقيقتين بكلمة OK لسرعة الاستجابة)
    setInterval(() => {
        // الحارس يتصل بنفس السيرفر محلياً وبسرعة فائقة دون الحاجة لروابط خارجية
        http.get(`http://localhost:${PORT}/uptime`, (res) => {
            // يتم استقبال الرد "OK" داخلياً للحفاظ على حيوية البوت
        }).on('error', (err) => {
            console.log('⏰ تنبيه الحارس:', err.message);
        });
    }, 120000); // كل دقيقتين (120000 ملي ثانية) لضمان عدم دخول وضع الغفوة
});

// 2. إعدادات البوت والتوكن الرسمي الخاص بك
const BOT_TOKEN = '8928251813:AAEj0xODDFxDe-F7KLzGzjznIJ27r_Jx0OI';
const bot = new Telegraf(BOT_TOKEN);

const DEVELOPER_ID = "snow_dev_id_10"; // معرف مستند حساب المطور الثابت لحمايتك
const CONFIG_PATH = path.join(__dirname, 'config.json');

// دوال حفظ واسترجاع البنوك من ملف config.json لضمان عدم ضياع البيانات
function loadBanksData() {
    try { if (fs.existsSync(CONFIG_PATH)) return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (e) { }
    return {};
}
function saveBanksData(data) { fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2), 'utf8'); }

let dbBridges = {}; // لتخزين كائنات الـ Firestore الحية لكل بنك مضاف
let userStates = {}; // لإدارة خطوات المحادثة والأمان لكل يوزر

// الأزرار الرئيسية للبوت
const mainKeyboard = Markup.keyboard([
    ['➕ إضافة بنك جدید', '📝 تعديل بنك قديم'],
    ['📢 إعلان جماعي', '❄️ تجميد جماعي']
]).resize();

bot.start((ctx) => {
    ctx.reply('👋 مرحباً بك في لوحة تحكم وحارس البنوك المركزي الرقمي ⛈️🛡️\nالرجاء اختيار أحد الأزرار للبدء:', mainKeyboard);
});

// دالة أمان مركزية لفحص تسجيل الدخول للآدمن داخل داتابيز البنك
async function verifyAdminAuth(firestoreDb, username, password) {
    try {
        const q = query(collection(firestoreDb, "users"), where("username", "==", username), where("password", "==", password), where("rol", "==", "ادمن"));
        const snapshot = await getDocs(q);
        return !snapshot.empty;
    } catch (e) { return false; }
}

// ================= [ 1. زر إضافة بنك جديد مع تسجيل الدخول ] =================
bot.hears('➕ إضافة بنك جدید', (ctx) => {
    userStates[ctx.chat.id] = { step: 'ADD_BANK_AUTH_USER' };
    ctx.reply('🔐 خطوة أمان حساسة: يرجى إدخال "اسم مستخدم الآدمن الخاص بك" للتحقق قبل الإضافة:');
});

// ================= [ 2. زر الإعلان الجماعي مع بوابة أمان ] =================
bot.hears('📢 إعلان جماعي', (ctx) => {
    userStates[ctx.chat.id] = { step: 'GLOBAL_AUTH_USER', action: 'BROADCAST' };
    ctx.reply('🔐 خطوة أمان حساسة: يرجى إدخال "اسم مستخدم الآدمن" لتأكيد صلاحية النشر الجماعي:');
});

// ================= [ 3. زر التجميد الجماعي مع بوابة أمان ] =================
bot.hears('❄️ تجميد جماعي', (ctx) => {
    userStates[ctx.chat.id] = { step: 'GLOBAL_AUTH_USER', action: 'FREEZE_ALL' };
    ctx.reply('🔐 خطوة أمان حساسة: يرجى إدخال "اسم مستخدم الآدمن" لتأكيد أمر التجميد الشامل لجميع البنوك:');
});

// ================= [ 4. زر تعديل بنك قديم والقوائم ] =================
bot.hears('📝 تعديل بنك قديم', async (ctx) => {
    const savedBanks = loadBanksData();
    const bankIds = Object.keys(savedBanks);
    if (bankIds.length === 0) return ctx.reply('❌ لا توجد بنوك مسجلة بالنظام حالياً!');
    
    let textMenu = '📝 **قائمة البنوك المربوطة بالحارس المركزي:**\n\n';
    let buttons = [];
    
    bankIds.forEach((id, index) => {
        textMenu += `${index + 1} - البنك: ${savedBanks[id].name}\n🔗 الرابط: ${savedBanks[id].url}\n\n`;
        buttons.push([Markup.button.callback(`⚙️ إدارة: ${savedBanks[id].name}`, `gate_${id}`)]);
    });
    
    textMenu += 'اختر البنك المراد تعديله لطلب تسجيل الدخول الفوري له:';
    ctx.reply(textMenu, Markup.inlineKeyboard(buttons));
});

// بوابة الأمان للبنك المحدد: طلب اسم المستخدم أولاً
bot.action(/gate_(.+)/, (ctx) => {
    const bankId = ctx.match[1];
    userStates[ctx.chat.id] = { step: 'BANK_AUTH_USER', bankId: bankId };
    ctx.reply('🔐 يرجى إدخال "اسم المستخدم" الخاص بحساب الآدمن للوصول إلى لوحة هذا البنك:');
});

// لوحة التحكم الفرعية بعد تخطي الأمان بنجاح
function openSubMenu(ctx, bankId) {
    const savedBanks = loadBanksData();
    const bank = savedBanks[bankId];
    ctx.reply(`🏦 **لوحة تحكم بنك: ${bank.name}**\nتخطيت الأمان بنجاح، اختر الإجراء الحساس المطلوب:`, 
        Markup.inlineKeyboard([
            [Markup.button.callback('❄️ تجميد البنك من الحارس', `subfreeze_${bankId}`)],
            [Markup.button.callback('🎁 إرسال هدية للبنك كامل', `subgift_${bankId}`)],
            [Markup.button.callback('👥 عرض قائمة الأعضاء أبجدياً', `submembers_${bankId}`)],
            [Markup.button.callback('🔗 رابط البنك', `suburl_${bankId}`), Markup.button.callback('🔍 حالة المطور', `subdev_${bankId}`)]
        ])
    );
}

// أفعال لوحة التحكم الفرعية
bot.action(/suburl_(.+)/, (ctx) => {
    const savedBanks = loadBanksData();
    ctx.reply(`🔗 رابط البنك هو:\n${savedBanks[ctx.match[1]].url}`);
});

bot.action(/subdev_(.+)/, async (ctx) => {
    const bankId = ctx.match[1];
    const firestoreDb = dbBridges[bankId]?.firestore;
    if (!firestoreDb) return ctx.reply('❌ خطأ في الاتصال بالداتابيز الحية!');
    try {
        const dDoc = await getDoc(doc(firestoreDb, "users", DEVELOPER_ID));
        if (dDoc.exists()) ctx.reply('✅ حساب المطور موجود وسليم تماماً ولم يتم حذفه.');
        else ctx.reply('🚨 تحذير: حساب المطور تم حذفه من هذا البنك!');
    } catch(e) { ctx.reply('🚨 تحذير: حساب المطور غير موجود أو تعذر الوصول له!'); }
});

bot.action(/subfreeze_(.+)/, async (ctx) => {
    const bankId = ctx.match[1];
    const firestoreDb = dbBridges[bankId]?.firestore;
    if (!firestoreDb) return ctx.reply('❌ خطأ في الاتصال بقاعدة البيانات!');
    try {
        await setDoc(doc(firestoreDb, "settings", "status"), { isFrozen: true }, { merge: true });
        ctx.reply('🔒 تم تجميد البنك من الحارس المركزي بنجاح وقفل العمليات!');
    } catch(e) { ctx.reply('❌ فشل إرسال أمر التجميد!'); }
});

bot.action(/subgift_(.+)/, (ctx) => {
    userStates[ctx.chat.id] = { step: 'GIFT_AMT', bankId: ctx.match[1] };
    ctx.reply('💰 اكتب مبلغ الهدية المراد شحنها لكافة الأعضاء في البنك:');
});

bot.action(/submembers_(.+)/, async (ctx) => {
    const bankId = ctx.match[1];
    const firestoreDb = dbBridges[bankId]?.firestore;
    if (!firestoreDb) return ctx.reply('❌ السيرفر غير متصل بقاعدة هذا البنك حياً!');
    ctx.reply('🔄 جاري سحب الأعضاء وترتيبهم أبجدياً...');
    
    try {
        const q = query(collection(firestoreDb, "users"), orderBy("username", "asc"));
        const snapshot = await getDocs(q);
        let listStr = `👥 **أعضاء البنك مرتبين أبجدياً:**\n\n`;
        let userTrack = [];
        let i = 1;
        
        snapshot.forEach((dSnap) => {
            const u = dSnap.data();
            listStr += `${i} - ${u.username || dSnap.id}\n`;
            userTrack.push({ index: i, id: dSnap.id, username: u.username });
            i++;
        });
        
        userStates[ctx.chat.id] = { step: 'SELECT_USER_NUM', bankId: bankId, users: userTrack };
        await ctx.reply(listStr);
        ctx.reply('📥 اكتب الآن "رقم العضو" من القائمة لتعديله أو حذفه:');
    } catch(e) { ctx.reply('❌ فشل سحب الأعضاء! يرجى مراجعة الصلاحيات لقاعدتك.'); }
});

// ================= [ 🤖 معالج المدخلات النصية وبوابات الأمان الذكية ] =================
bot.on('text', async (ctx, next) => {
    const state = userStates[ctx.chat.id];
    if (!state) return next();
    const text = ctx.message.text;

    // أمان إضافة بنك جديد
    if (state.step === 'ADD_BANK_AUTH_USER') {
        state.adminUser = text;
        state.step = 'ADD_BANK_AUTH_PASS';
        ctx.reply('🔑 أدخل "كلمة المرور" للتحقق من الصلاحيات الإدارية:');
        return;
    }
    if (state.step === 'ADD_BANK_AUTH_PASS') {
        state.adminPass = text;
        state.step = 'WAITING_CONFIG_OBJ';
        ctx.reply('🔒 تم التحقق الأولي. الآن أرسل قاعدة الفايربيز (Firebase Config) كامله كما هي بالموقع ليتم فحصها:');
        return;
    }
    if (state.step === 'WAITING_CONFIG_OBJ') {
        const apiKey = text.match(/apiKey:\s*"([^"]+)"/);
        const projectId = text.match(/projectId:\s*"([^"]+)"/);
        if (apiKey && projectId) {
            const pId = projectId[1];
            ctx.reply(`🔍 القاعدة [${pId}] تحت التأكيد والفحص الفوري...`);
            try {
                const fConfig = {
                    apiKey: apiKey[1],
                    projectId: pId,
                    authDomain: text.match(/authDomain:\s*"([^"]+)"/)?.[1] || "",
                    storageBucket: text.match(/storageBucket:\s*"([^"]+)"/)?.[1] || "",
                    messagingSenderId: text.match(/messagingSenderId:\s*"([^"]+)"/)?.[1] || "",
                    appId: text.match(/appId:\s*"([^"]+)"/)?.[1] || ""
                };
                const fApp = initializeApp(fConfig, pId);
                const fDb = getFirestore(fApp);
                
                // التأكد الفعلي من هوية الإدارة بداخل القاعدة المرفوعة نفسها!
                const isRealAdmin = await verifyAdminAuth(fDb, state.adminUser, state.adminPass);
                if (!isRealAdmin) {
                    ctx.reply('❌ فشل الأمان! الحساب والرمز اللذان أدخلتهما لا يملكان رتبة "ادمن" في هذه القاعدة! تم إلغاء الإضافة.');
                    delete userStates[ctx.chat.id];
                    return;
                }
                
                userStates[ctx.chat.id] = { step: 'WAITING_BANK_NAME', config: fConfig, firestore: fDb, projectId: pId };
                ctx.reply('✅ تم فحص وتأكيد القاعدة وتسجيل دخولك بنجاح! الآن اكتب "اسم البنك الجديد":');
            } catch(e) { ctx.reply('❌ ظهر خطأ أثناء فحص القاعدة والاتصال بها! أعد إرسال القاعدة الصحيحة:'); }
        } else { ctx.reply('❌ خطأ في الأكواد! يرجى إعادة إرسال القاعدة كاملة وصحيحة:'); }
        return;
    }
    if (state.step === 'WAITING_BANK_NAME') {
        state.bName = text;
        state.step = 'WAITING_BANK_URL';
        ctx.reply('🔗 جيب الآن رابط البنك (الموقع الإلكتروني الرسمي):');
        return;
    }
    if (state.step === 'WAITING_BANK_URL') {
        const savedBanks = loadBanksData();
        savedBanks[state.projectId] = { name: state.bName, url: text, config: state.config };
        saveBanksData(savedBanks);
        
        dbBridges[state.projectId] = { name: state.bName, url: text, firestore: state.firestore };
        ctx.reply(`🎉 تم حفظ البنك [${state.bName}] بنجاح، والحارس المتقدم يراقب الأنظمة الآن الفارق بالملي ثانية!`);
        
        activateLiveMonitor(state.projectId);
        delete userStates[ctx.chat.id];
        return;
    }

    // بوابات أمان العمليات الجماعية (إعلان / تجميد شامل)
    if (state.step === 'GLOBAL_AUTH_USER') {
        state.adminUser = text;
        state.step = 'GLOBAL_AUTH_PASS';
        ctx.reply('🔑 أدخل "كلمة المرور" لتأكيد الهوية الإدارية المركزية للعملية:');
        return;
    }
    if (state.step === 'GLOBAL_AUTH_PASS') {
        const savedBanks = loadBanksData();
        const ids = Object.keys(savedBanks);
        if(ids.length === 0) {
            ctx.reply('❌ لا توجد بنوك مسجلة.');
            delete userStates[ctx.chat.id];
            return;
        }
        
        // التحقق من صلاحيته كآدمن في أول بنك متاح كتأكيد مركزي للهوية
        const checkDb = dbBridges[ids[0]]?.firestore;
        if (!checkDb || !(await verifyAdminAuth(checkDb, state.adminUser, text))) {
            ctx.reply('❌ الرمز أو الحساب غير صحيح! تم رفض العملية الجماعية لحماية البنوك.');
            delete userStates[ctx.chat.id];
            return;
        }
        
        if (state.action === 'FREEZE_ALL') {
            ctx.reply('🔄 جاري تفعيل الحارس وتجميد العمليات بجميع البنوك...');
            for (const id of ids) {
                try { await setDoc(doc(dbBridges[id].firestore, "settings", "status"), { isFrozen: true }, { merge: true }); } catch(e){}
            }
            ctx.reply('❄️ تم تجميد وقفل جميع البنوك المربوطة بنجاح تامة!');
            delete userStates[ctx.chat.id];
        } else if (state.action === 'BROADCAST') {
            state.step = 'WRITE_BROADCAST_TEXT';
            ctx.reply('📝 تم تأكيد الهوية. اكتب نص الإعلان البنر الجديد لرفعه على البنوك:');
        }
        return;
    }
    if (state.step === 'WRITE_BROADCAST_TEXT') {
        const ids = Object.keys(dbBridges);
        let count = 0;
        for (const id of ids) {
            try {
                const fDb = dbBridges[id].firestore;
                const devSnap = await getDoc(doc(fDb, "users", DEVELOPER_ID));
                if (devSnap.exists()) {
                    await setDoc(doc(fDb, "settings", "announcement"), { text: text }, { merge: true });
                    count++;
                }
            } catch(e){}
        }
        ctx.reply(`📢 تم رفع الإعلان لكافة البنوك بنجاح! (العدد المستجيب والموثق: ${count})`);
        delete userStates[ctx.chat.id];
        return;
    }

    // أمان لوحة البنك الفرعي القديم
    if (state.step === 'BANK_AUTH_USER') {
        state.adminUser = text;
        state.step = 'BANK_AUTH_PASS';
        ctx.reply('🔑 أدخل "كلمة المرور" التابعة للحساب لدخول هذا البنك المحدّد:');
        return;
    }
    if (state.step === 'BANK_AUTH_PASS') {
        const fDb = dbBridges[state.bankId]?.firestore;
        if (!fDb) { ctx.reply('❌ البنك غير متصل حالياً بالسيرفر الحي!'); delete userStates[ctx.chat.id]; return; }
        
        if (await verifyAdminAuth(fDb, state.adminUser, text)) {
            ctx.reply('✅ تم التحقق وتأكيد حساب الإدارة بنجاح!');
            openSubMenu(ctx, state.bankId);
        } else {
            ctx.reply('❌ الرمز أو الحساب غير صحيح! تم حظر محاولة الوصول الفرعية.');
        }
        delete userStates[ctx.chat.id];
        return;
    }

    // توزيع الهدية الجماعية للبنك الفرعي
    if (state.step === 'GIFT_AMT') {
        state.amt = parseInt(text);
        if (isNaN(state.amt)) return ctx.reply('❌ يرجى إرسال رقم صحيح للمبلغ!');
        state.step = 'GIFT_MSG';
        ctx.reply('📝 ارسل الآن نص رسالة الهدية التوضيحية ليتم التوزيع فورا:');
        return;
    }
    if (state.step === 'GIFT_MSG') {
        const fDb = dbBridges[state.bankId].firestore;
        ctx.reply('🔄 جاري توزيع وشحن رصيد كافة الأعضاء بالداتابيز...');
        try {
            const sn = await getDocs(collection(fDb, "users"));
            sn.forEach(async (d) => {
                const b = d.data().balance || 0;
                await updateDoc(doc(fDb, "users", d.id), { balance: b + state.amt });
            });
            ctx.reply(`🎁 تم بنجاح توزيع الهدية بقيمة (${state.amt}) على البنك كامل!`);
        } catch(e) { ctx.reply('❌ حدث خطأ في توزيع الهدية.'); }
        delete userStates[ctx.chat.id];
        return;
    }

    // تعديل وحذف العضو الفرعي من القائمة المرقبة
    if (state.step === 'SELECT_USER_NUM') {
        const num = parseInt(text);
        const userSelected = state.users.find(u => u.index === num);
        if (!userSelected) return ctx.reply('❌ رقم العضو المدخل غير صحيح! اختر من القائمة بالأعلى:');
        
        ctx.reply(`👤 **تعديل حساب العضو: ${userSelected.username}**\nاختر أحد الإجراءات الحساسة الفورية له:`,
            Markup.inlineKeyboard([
                [Markup.button.callback('➕➖ خصم وإضافة رصيد', `uval_${state.bankId}_${userSelected.id}`)],
                [Markup.button.callback('❄️ تجميد الحساب', `ufrz_${state.bankId}_${userSelected.id}`)],
                [Markup.button.callback('🗑️ حذف نهائي', `udel_${state.bankId}_${userSelected.id}`)]
            ])
        );
        delete userStates[ctx.chat.id];
        return;
    }
    if (state.step === 'CONFIRM_VAL_CHANGE') {
        const val = parseInt(text);
        if (isNaN(val)) return ctx.reply('❌ يرجى إرسال قيمة رقمية صحيحة! (مثال: 50000 أو -30000):');
        try {
            const ref = doc(dbBridges[state.bankId].firestore, "users", state.uId);
            const s = await getDoc(ref);
            const currentB = s.data().balance || 0;
            await updateDoc(ref, { balance: currentB + val });
            ctx.reply(`✅ تم تعديل الرصيد بنجاح! الرصيد الجديد أصبح: ${(currentB + val).toLocaleString()}`);
        } catch(e) { ctx.reply('❌ فشل تعديل الرصيد!'); }
        delete userStates[ctx.chat.id];
        return;
    }
});

// أزرار تفاعل تحكم الأعضاء المدمجة بالـ Inline
bot.action(/uval_(.+)_(.+)/, (ctx) => {
    userStates[ctx.chat.id] = { step: 'CONFIRM_VAL_CHANGE', bankId: ctx.match[1], uId: ctx.match[2] };
    ctx.reply('📥 اكتب الرقم المطلوب للتعديل (رقم موجب للإضافة وسالب للخصم فورا):');
});

bot.action(/ufrz_(.+)_(.+)/, async (ctx) => {
    try {
        await updateDoc(doc(dbBridges[ctx.match[1]].firestore, "users", ctx.match[2]), { isFrozen: true });
        ctx.reply('❄️ تم تجميد الحساب بنجاح وقفل العمليات الخاصة به!');
    } catch(e) { ctx.reply('❌ فشل تجميد حساب العضو!'); }
});

bot.action(/udel_(.+)_(.+)/, async (ctx) => {
    try {
        await deleteDoc(doc(dbBridges[ctx.match[1]].firestore, "users", ctx.match[2]));
        ctx.reply('🗑️ تم حذف حساب العضو نهائياً من قاعدة بيانات هذا البنك!');
    } catch(e) { ctx.reply('❌ فشل عملية حذف الحساب!'); }
});

// ================= [ ⚙️ قسم البنك المراقب الفوري المتطور وشامل الحماية السيبرانية ] =================
function activateLiveMonitor(bankId) {
    const bank = dbBridges[bankId];
    const fDb = bank.firestore;

    onSnapshot(collection(fDb, "users"), (snapshot) => {
        snapshot.docChanges().forEach(async (change) => {
            if (change.type === "modified") {
                const uData = change.doc.data();
                const uId = change.doc.id;

                // [1] مراقب المليون لحسابات اليوزرات العاديين بدون رتب آدمن
                if (uData.balance > 1000000 && uData.rol !== "ادمن") {
                    bot.telegram.sendMessage(5378514746, 
                        `🚨 **مراقب المليون: رصد ثراء فاحش ومشبوه!** 🚨\n\n` +
                        `🏦 البنك: ${bank.name}\n` +
                        `🔗 الرابط: ${bank.url}\n` +
                        `👤 الحساب: ${uData.username || 'يوزر'}\n` +
                        `💰 رصيده المكتشف: ${(uData.balance || 0).toLocaleString()} بوينت\n` +
                        `⚠️ الحساب تخطى حاجز المليون بدون رتبة آدمن مصرح بها!`,
                        Markup.inlineKeyboard([
                            [Markup.button.callback('🗑️ حذف الحساب فورا', `udel_${bankId}_${uId}`)],
                            [Markup.button.callback('❄️ تجميد حساب اللاعب', `ufrz_${bankId}_${uId}`)]
                        ])
                    );
                }

                // [2] كاشف التزوير المتطور جداً (تعديل رصيد بدون أي سجل رسمي)
                setTimeout(async () => {
                    try {
                        let hasLoggedInvoice = false;
                        
                        // فحص سجل الحوالات العام والخاص بالموقع
                        const txs = await getDocs(collection(fDb, "transactions"));
                        txs.forEach(tDoc => {
                            const t = tDoc.data();
                            if (t.sender === uData.username || t.receiver === uData.username) hasLoggedInvoice = true;
                        });

                        // فحص المتجر والطلبات لعدم الظلم
                        const ords = await getDocs(collection(fDb, "orders"));
                        ords.forEach(oDoc => { if (oDoc.data().username === uData.username) hasLoggedInvoice = true; });

                        // النتيجة: إذا تم رصد حركة بالرصيد ولا يوجد أي فاتورة سجل تثبتها فهو تزوير وهكر
                        if (!hasLoggedInvoice && uData.rol !== "ادمن") {
                            bot.telegram.sendMessage(5378514746,
                                `⚠️ **كاشف التزوير: رصد تعديل رصيد بدون أي سجل!** ⚠️\n\n` +
                                `🏦 البنك: ${bank.name}\n` +
                                `👤 الحساب المخالف: ${uData.username}\n` +
                                `❗ تم تعديل وتزوير نقاط اللاعب يدوياً خارج نطاق التحويلات والمتجر المعتمد بالسجلات!`,
                                Markup.inlineKeyboard([
                                    [Markup.button.callback('🛑 توقيف وحذف الحساب المخالف', `udel_${bankId}_${uId}`)]
                                ])
                            );
                        }
                    } catch(e){}
                }, 3500); // إعطاء 3.5 ثانية مهلة لكتابة السجل الطبيعي بالموقع أولاً لعدم الخطأ

                // [3] مراقبة حركة إضافة وتعديل حسابات الآدمنية (Admin Monitor)
                if (uData.rol === "ادمن" && uId !== DEVELOPER_ID) {
                    bot.telegram.sendMessage(5378514746,
                        `⚔️ **حارس الأمن: رصد ترقية أو إضافة آدمن جديد!** ⚔️\n\n` +
                        `🏦 البنك: ${bank.name}\n` +
                        `🔗 الرابط: ${bank.url}\n` +
                        `👤 اسم المستخدم: ${uData.username}\n` +
                        `🆔 المعرف: ${uId}\n` +
                        `🚨 تم منح صلاحية آدمن كاملة لهذا الحساب خارج لوحة التحكم المركزية الموثقة!`,
                        Markup.inlineKeyboard([
                            [Markup.button.callback('❄️ تجميد البنك بالكامل فورا', `subfreeze_${bankId}`)],
                            [Markup.button.callback('❄️ تجميد حساب الآدمن المضاف', `ufrz_${bankId}_${uId}`)],
                            [Markup.button.callback('🗑️ حذف حساب الآدمن', `udel_${bankId}_${uId}`)]
                        ])
                    );
                }
            }
        });
    });

    // [4] مراقب المطور الدوري التلقائي (يفحص كل دقيقة)
    setInterval(async () => {
        try {
            const devDoc = await getDoc(doc(fDb, "users", DEVELOPER_ID));
            if (!devDoc.exists()) {
                bot.telegram.sendMessage(5378514746,
                    `🚨 **تمرد أمني: تم حذف حساب المطور من البنك الفرعي!** 🚨\n\n` +
                    `🏦 البنك المعني: ${bank.name}\n` +
                    `❌ قام صاحب البنك بحذف مستند حساب المطور لإلغاء تحكمك! تم رصده وسيتم التجميد بنقرة واحدة:`,
                    Markup.inlineKeyboard([[Markup.button.callback('❄️ تجميد هذا البنك فوراً كعقوبة', `subfreeze_${bankId}`)]])
                );
            }
        } catch(e) {}
    }, 60000);
}

// دالة تهيئة البنوك المحفوظة عند إعادة تشغيل السيرفر تلقائياً لكي لا يتوقف الحارس
function initializeSavedBanks() {
    const savedBanks = loadBanksData();
    Object.keys(savedBanks).forEach(pId => {
        try {
            const fApp = initializeApp(savedBanks[pId].config, pId);
            const fDb = getFirestore(fApp);
            dbBridges[pId] = { name: savedBanks[pId].name, url: savedBanks[pId].url, firestore: fDb };
            activateLiveMonitor(pId);
        } catch(e) { console.log(`خطأ في تهيئة البنك القديم: ${pId}`); }
    });
}

initializeSavedBanks();
bot.launch();