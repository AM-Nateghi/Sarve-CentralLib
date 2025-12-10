const TIME_WINDOWS = ["8-11", "11-14", "14-17", "17-20", "20-21"];
let currentEditDay = null;
let currentCustomReserveDate = null;
let socket = null;
let historyExpanded = false;
const progressToasts = new Map();

// ==================== WebSocket Setup ====================
function initWebSocket() {
    socket = io();

    socket.on("connect", () => console.log("[WebSocket] Connected:", socket.id));

    socket.on("reserve:start", (data) => {
        console.log("[WebSocket] Reserve started:", data);
        showToast(`🚀 شروع رزرو برای ${data.windows.join(", ")}`, true);
    });

    socket.on("reserve:complete", (data) => {
        console.log("[WebSocket] Reserve complete:", data);
        loadHistory();
        showToast(`✅ رزرو تکمیل شد`, true);
        if (data.runId && data.results) {
            data.results.forEach((r) => {
                const key = `${data.runId}-${r.label}`;
                updateProgressToast(key, { status: r.success ? "done" : "error", message: r.message || "پایان", percent: 100 });
            });
        }
    });

    socket.on("reserve:progress", (payload) => {
        const { runId, label, step, totalSteps, message, status } = payload;
        const percent = Math.min(100, Math.round((step / totalSteps) * 100));
        const key = `${runId}-${label}`;
        const title = label === "login" ? "ورود" : `رزرو ${label}`;
        updateProgressToast(key, { title, message, percent, status: status === "error" ? "error" : "در حال انجام" });
    });

    socket.on("custom-schedule:complete", (data) => {
        console.log("[WebSocket] Custom schedule complete:", data);
        loadConfig();
        showToast(`✅ تایم‌بندی ثبت شد`, true);
    });

    socket.on("disconnect", () => console.log("[WebSocket] Disconnected"));
}

// ==================== Modal & Toast Helpers ====================
function showModal(modalId) {
    $(`#${modalId}`).removeClass("opacity-0 pointer-events-none");
}

function hideModal(modalId) {
    $(`#${modalId}`).addClass("opacity-0 pointer-events-none");
}

function toggleHistory() {
    const $wrap = $("#historyWrapper");
    const $btn = $("#toggleHistoryBtn");
    historyExpanded = !historyExpanded;
    if (historyExpanded) {
        $wrap.removeClass("max-h-80 sm:max-h-96").addClass("max-h-[70vh]");
        $btn.text("نمایش کمتر").attr("aria-expanded", "true");
    } else {
        $wrap.addClass("max-h-80 sm:max-h-96").removeClass("max-h-[70vh]");
        $btn.text("نمایش بیشتر").attr("aria-expanded", "false");
    }
}

function showToast(message, isSuccess = true) {
    const icon = isSuccess ? "✓" : "⚠️";
    const $toast = $("#toast");
    $("#toastMessage").text(`${icon} ${message}`);
    $toast.removeClass("bg-red-600 bg-slate-900").addClass(isSuccess ? "bg-slate-900" : "bg-red-600");
    $toast.removeClass("opacity-0");
    
    // Cancel any existing timeout
    if ($toast.data('timeout')) clearTimeout($toast.data('timeout'));
    
    // Auto-hide after 3 seconds
    const timeout = setTimeout(() => {
        $toast.addClass("opacity-0");
    }, 3000);
    
    $toast.data('timeout', timeout);
}

// Gamble modal helpers - REMOVED
function buildCustomScheduleUI() {
    // Build reserve date grid (10 days ahead)
    const $reserveDateGrid = $("#reserveDateGrid");
    $reserveDateGrid.empty();
    const now = new Date();
    
    for (let i = 0; i < 10; i++) {
        const d = new Date();
        d.setDate(now.getDate() + i);
        const iso = d.toISOString().slice(0, 10);
        const label = jalaliOf(d);
        const badge = i === 0 ? "(امروز)" : i === 1 ? "(فردا)" : "";
        const $btn = $(`<button type="button" class="w-full border rounded-lg p-2 text-sm hover:border-blue-500 hover:bg-blue-50 transition flex flex-col items-start gap-1" data-date="${iso}">
                    <span class="font-semibold">${label}</span><span class="text-xs text-slate-500">${badge}</span>
                </button>`);
        $btn.on("click", () => {
            currentCustomReserveDate = iso;
            $("#reserveDateGrid button").each((_, el) => {
                const active = $(el).data("date") === iso;
                $(el).toggleClass("border-blue-500", active).toggleClass("bg-blue-50", active);
            });
        });
        $reserveDateGrid.append($btn);
        if (i === 0) {
            currentCustomReserveDate = iso;
            $btn.addClass("border-blue-500 bg-blue-50");
        }
    }

    // Build windows checkboxes
    const $windowsGrid = $("#scheduleWindowsGrid");
    $windowsGrid.empty();
    TIME_WINDOWS.forEach((w) => {
        $windowsGrid.append(`
            <label class="flex items-center gap-2 p-3 border border-slate-200 rounded-lg hover:bg-blue-50 cursor-pointer transition">
              <input type="checkbox" value="${w}" class="schedule-window accent-blue-600 w-5 h-5">
              <span class="font-medium text-sm">${w}</span>
            </label>
          `);
    });

    // Set default execution time
    const tomorrow = new Date();
    tomorrow.setDate(now.getDate() + 1);
    $("#executionDateInput").val(tomorrow.toISOString().slice(0, 10));
    $("#executionHourInput").val("07");
    $("#executionMinuteInput").val("00");
}

// Toasts with progress
function ensureProgressToast(key, title) {
    if (progressToasts.has(key)) return progressToasts.get(key);
    const $container = $("#progressToastContainer");
    const $wrap = $(`
                <div class="progress-toast bg-white border border-slate-200 rounded-xl p-3 pointer-events-auto">
                    <div class="flex items-center justify-between mb-2">
                        <span class="text-sm font-semibold text-slate-800" data-title>${title}</span>
                        <span class="text-xs text-slate-500" data-status>در حال انجام</span>
                    </div>
                    <div class="text-xs text-slate-600 mb-2" data-message></div>
                    <div class="w-full h-2 bg-slate-100 rounded-full overflow-hidden">
                        <div class="h-2 shimmer-bar w-0" data-bar></div>
                    </div>
                </div>
            `);
    $container.append($wrap);
    progressToasts.set(key, { el: $wrap[0], $el: $wrap, timeout: null });
    reorderProgressToasts();
    return $wrap[0];
}

function reorderProgressToasts() {
    const $container = $("#progressToastContainer");
    progressToasts.forEach((item) => {
        $container.append(item.el);
    });
}

function updateProgressToast(key, { title, message, percent, status }) {
    const item = progressToasts.get(key);
    if (!item) return ensureProgressToast(key, title || "رزرو");
    
    const $el = item.$el;
    if (title) $el.find('[data-title]').text(title);
    if (message) $el.find('[data-message]').text(message);
    if (typeof percent === "number") {
        $el.find('[data-bar]').css("width", `${Math.max(5, percent)}%`);
    } else {
        $el.find('[data-bar]').css("width", "15%");
    }
    if (status) {
        const map = { done: "تمام", error: "خطا" };
        $el.find('[data-status]').text(map[status] || status);
    }
    if (status === "done" || status === "error") {
        $el.find('[data-bar]').removeClass("shimmer-bar");
        
        // Cancel existing timeout if any
        if (item.timeout) clearTimeout(item.timeout);
        
        // Auto-remove after 3 seconds
        item.timeout = setTimeout(() => {
            $el.fadeOut(300, function() {
                $(this).remove();
                progressToasts.delete(key);
                reorderProgressToasts();
            });
        }, 3000);
    }
}

// ==================== Jalali Date Helper ====================
function jalaliOf(d) {
    const gy = d.getFullYear(), gm = d.getMonth() + 1, gd = d.getDate();
    function div(a, b) { return Math.floor(a / b); }
    const g_d_m = [0, 31, ((gy % 4 === 0 && gy % 100 !== 0) || (gy % 400 === 0)) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let gy2 = gy - 1600, gm2 = gm - 1, gd2 = gd - 1;
    let g_day_no = 365 * gy2 + div(gy2 + 3, 4) - div(gy2 + 99, 100) + div(gy2 + 399, 400);
    for (let i = 0; i < gm2; i++) g_day_no += g_d_m[i + 1];
    g_day_no += gd2;
    let j_day_no = g_day_no - 79;
    const j_np = div(j_day_no, 12053); j_day_no %= 12053;
    let jy = 979 + 33 * j_np + 4 * div(j_day_no, 1461); j_day_no %= 1461;
    if (j_day_no >= 366) { jy += div(j_day_no - 366, 365); j_day_no = (j_day_no - 366) % 365; }
    const jm_list = [31, 31, 31, 31, 31, 31, 30, 30, 30, 30, 30, 29];
    let jm = 0; for (; jm < 12 && j_day_no >= jm_list[jm]; jm++) j_day_no -= jm_list[jm];
    const jd = j_day_no + 1;
    return `${jy}/${String(jm + 1).padStart(2, "0")}/${String(jd).padStart(2, "0")}`;
}

// ==================== Load and Render Config ====================
function loadConfig() {
    $.getJSON("/api/config")
        .done((cfg) => {
            $("#seatDisplay").text(cfg.seat_number);
            $("#dateModeDisplay").text(cfg.reserveDateMode === "tomorrow" ? "🌙 فردا" : "☀️ امروز");
            $("#quotaDisplay").text(cfg.lastMonthQuota || "اطلاعاتی موجود نیست");

            $("#usernameInput").val(cfg.username || "");
            $("#passwordInput").val(cfg.passwd || "");
            $("#seatNumberInput").val(cfg.seat_number || 33);
            $("#seatPriorityInput").val((cfg.seat_priority || [33, 32, 34, 37, 42]).join(","));
            $("#concurrencyInput").val(typeof cfg.concurrency !== "undefined" ? cfg.concurrency : 3);
            $("#requestSpreadInput").val(typeof cfg.requestStartSpreadMs !== "undefined" ? cfg.requestStartSpreadMs : 400);
            $("#scInput").val(cfg.sc || "");

            if (cfg.reserveDateMode === "tomorrow") {
                $("#tomorrowRadio").prop("checked", true);
            } else {
                $("#todayRadio").prop("checked", true);
            }

            const $wrap = $("#windowsGrid");
            $wrap.empty();
            const selected = cfg.selectedWindows || [];
            TIME_WINDOWS.forEach((w) => {
                const checked = selected.includes(w);
                $wrap.append(`
            <label class="flex items-center gap-2 p-3 border border-slate-200 rounded-lg hover:bg-indigo-50 cursor-pointer transition ${checked ? 'bg-indigo-50 border-indigo-400' : ''}">
              <input type="checkbox" value="${w}" ${checked ? "checked" : ""} class="window-checkbox accent-indigo-600 w-5 h-5">
              <span class="font-medium text-sm">${w}</span>
            </label>
          `);
            });

            renderWeekTable(cfg);
            renderCustomSchedules(cfg.customSchedules || []);
            loadHistory();
        })
        .fail((_, __, err) => {
            showToast("خطا در بارگذاری تنظیمات: " + err, false);
        });
}

function renderCustomSchedules(schedules) {
    const $container = $("#customSchedulesContainer");
    $container.empty();

    if (!schedules || schedules.length === 0) {
        $container.html('<p class="text-sm text-slate-500 text-center py-4">هیچ زمان‌بندی دلخواهی ثبت نشده است</p>');
        return;
    }

    schedules.forEach((schedule) => {
        const reserveDate = schedule.reserveDate;
        const d = new Date(reserveDate);
        const shamsi = jalaliOf(d);
        const executionTime = `${String(schedule.executionHour).padStart(2, '0')}:${String(schedule.executionMinute).padStart(2, '0')}`;
        const executionDate = schedule.executionDate;
        const executionD = new Date(executionDate);
        const executionShamsi = jalaliOf(executionD);
        const statusBadge = schedule.executed 
            ? '<span class="text-xs font-semibold px-2 py-1 rounded-full bg-green-100 text-green-700">✓ ثبت‌شده</span>'
            : '<span class="text-xs font-semibold px-2 py-1 rounded-full bg-blue-100 text-blue-700">⏳ زمان‌بندی شده</span>';

        const $card = $(`
            <div class="rounded-lg border border-slate-200 bg-slate-50 p-4">
                <div class="flex items-start justify-between gap-3 mb-3">
                    <div>
                        <div class="font-semibold text-slate-800">رزرو: ${shamsi}</div>
                        <div class="text-xs text-slate-500 mt-1">بازه‌ها: ${schedule.windows.join(", ")}</div>
                    </div>
                    ${statusBadge}
                </div>
                <div class="text-sm text-slate-700 mt-3 mb-3">
                    <span class="font-medium">اجرا در:</span> ${executionShamsi} ساعت ${executionTime}
                </div>
                <button class="text-red-600 hover:text-red-800 text-sm font-semibold" onclick="deleteCustomSchedule('${schedule.id}')">🗑️ حذف</button>
            </div>
        `);
        $container.append($card);
    });
}

function loadHistory() {
    $.getJSON("/api/history?limit=50")
        .done((data) => {
            if (data.ok && data.entries && data.entries.length > 0) {
                renderHistory(data.entries);
            } else {
                renderEmptyHistory();
            }
        })
        .fail((_, __, err) => {
            console.error("Error loading history:", err);
            renderEmptyHistory();
        });
}

function renderHistory(entries) {
    const $tbody = $("#historyTableBody");
    const $emptyMsg = $("#historyEmpty");
    const $cardWrap = $("#historyCards");

    $tbody.empty();
    $cardWrap.empty();
    $emptyMsg.hide();

    entries.forEach((entry) => {
        let statusIcon, statusColor, statusText;

        if (entry.status === "success") {
            statusIcon = "✅";
            statusColor = "bg-green-50 text-green-700";
            statusText = "موفق";
        } else if (entry.status === "failed") {
            statusIcon = "❌";
            statusColor = "bg-red-50 text-red-700";
            statusText = "ناموفق";
        } else if (entry.status === "scheduled") {
            statusIcon = "📅";
            statusColor = "bg-blue-50 text-blue-700";
            statusText = "تایم‌بندی شده";
        } else {
            statusIcon = "❓";
            statusColor = "bg-slate-50 text-slate-700";
            statusText = "نامعلوم";
        }

        const timestamp = new Date(entry.timestamp || entry.created_at || Date.now());
        const time = timestamp.toLocaleTimeString("fa-IR", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "Asia/Tehran" });

        const dateStr = entry.jalaliDate || (entry.date ? jalaliOf(new Date(entry.date)) : "—");
        const message = entry.message || entry.error || "—";

        $tbody.append(`
          <tr class="hover:bg-slate-50 transition">
                        <td class="py-3 text-right text-sm">${dateStr}</td>
            <td class="py-3 text-right text-sm font-mono">${entry.window || "—"}</td>
            <td class="py-3 text-right">
              <span class="text-xs font-semibold px-2 py-1 rounded-full ${statusColor}">
                ${statusIcon} ${statusText}
              </span>
            </td>
            <td class="py-3 text-right text-xs text-slate-600 max-w-xs truncate" title="${message}">${message}</td>
            <td class="py-3 text-right text-xs text-slate-500">${time}</td>
          </tr>
        `);

        $cardWrap.append(`
                    <div class="rounded-xl border border-slate-100 bg-white/90 p-4 shadow-sm">
                        <div class="flex items-start justify-between gap-3">
                            <div>
                                <div class="font-semibold text-slate-800">${dateStr}</div>
                                <div class="text-xs text-slate-500 mt-1">${entry.window || "—"}</div>
                            </div>
                            <span class="text-xs font-semibold px-2 py-1 rounded-full ${statusColor}">${statusIcon} ${statusText}</span>
                        </div>
                        <p class="text-sm text-slate-700 mt-3 overflow-hidden" style="display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;">${message}</p>
                        <div class="text-xs text-slate-500 mt-3">${time}</div>
                    </div>
                `);
    });
}

function renderEmptyHistory() {
    $("#historyTableBody").empty();
    $("#historyCards").empty();
    $("#historyEmpty").show();
}

function renderWeekTable(cfg) {
    const $tbody = $("#weekTableBody");
    const $cards = $("#weekCards");
    $tbody.empty();
    $cards.empty();
    const now = new Date();

    for (let i = 0; i <= 9; i++) {
        const d = new Date();
        d.setDate(now.getDate() + i);
        const iso = d.toISOString().slice(0, 10);
        const scheduled = cfg.scheduledDays?.[iso] || [];
        const shamsi = jalaliOf(d);
        const isToday = i === 0;
        const isTomorrow = i === 1;
        const windowsText = scheduled.length > 0 ? scheduled.join(", ") : "—";
        
        // Determine status based on scheduledDays or custom schedules
        let badgeClass = "bg-slate-100 text-slate-600";
        let badgeLabel = "خالی";
        
        if (scheduled.length > 0) {
            badgeClass = "bg-yellow-100 text-yellow-700";
            badgeLabel = "📅 زمان‌بندی شده";
        }

        $tbody.append(`
          <tr class="hover:bg-slate-50 transition">
            <td class="py-3 text-right">
              <div class="font-medium">${shamsi}</div>
              <div class="text-xs text-slate-500">${isToday ? "(امروز)" : isTomorrow ? "(فردا)" : ""}</div>
            </td>
            <td class="py-3 text-right">
                            <div class="text-sm text-slate-600">${windowsText}</div>
            </td>
            <td class="py-3 text-right">
                            <span class="text-xs font-semibold px-2 py-1 rounded-full ${badgeClass}">
                                ${badgeLabel}
              </span>
            </td>
            <td class="py-3 text-right">
              <button onclick="editDay('${iso}')" class="text-indigo-600 hover:text-indigo-800 text-sm font-semibold hover:underline">ویرایش</button>
            </td>
          </tr>
        `);

        $cards.append(`
                    <div class="rounded-xl border border-slate-100 bg-white/90 p-4 shadow-sm">
                        <div class="flex items-start justify-between gap-3">
                            <div>
                                <div class="font-semibold text-slate-800">${shamsi}</div>
                                <div class="text-xs text-slate-500 mt-1">${isToday ? "(امروز)" : isTomorrow ? "(فردا)" : ""}</div>
                            </div>
                            <span class="text-xs font-semibold px-2 py-1 rounded-full ${badgeClass}">${badgeLabel}</span>
                        </div>
                        <div class="text-sm text-slate-600 mt-3">${windowsText}</div>
                        <div class="flex justify-end pt-3">
                            <button onclick="editDay('${iso}')" class="text-indigo-600 hover:text-indigo-800 text-sm font-semibold">ویرایش</button>
                        </div>
                    </div>
                `);
    }
}

// ==================== Edit Day ====================
function editDay(iso) {
    currentEditDay = iso;
    const d = new Date(iso);
    const shamsi = jalaliOf(d);
    $("#dayEditTitle").text(`ویرایش: ${shamsi}`);

    $.getJSON("/api/config", (cfg) => {
        const scheduled = cfg.scheduledDays?.[iso] || [];
        const $wrap = $("#dayEditCheckboxes");
        $wrap.empty();
        TIME_WINDOWS.forEach((w) => {
            const checked = scheduled.includes(w);
            $wrap.append(`
            <label class="flex items-center gap-2 p-3 border border-slate-200 rounded-lg hover:bg-indigo-50 cursor-pointer transition ${checked ? 'bg-indigo-50 border-indigo-400' : ''}">
              <input type="checkbox" class="dayedit-checkbox accent-indigo-600 w-5 h-5" value="${w}" ${checked ? "checked" : ""}>
              <span class="font-medium flex-1">${w}</span>
            </label>
          `);
        });
    });

    showModal("dayEditModal");
}

function saveDayEdit() {
    const selected = $(".dayedit-checkbox:checked").map((_, el) => $(el).val()).get();
    $.ajax({
        url: "/api/schedule-day",
        method: "POST",
        contentType: "application/json",
        data: JSON.stringify({ date: currentEditDay, windows: selected }),
    })
        .done((data) => {
            if (data.ok) {
                showToast("روز بروزشد شد");
                hideModal("dayEditModal");
                loadConfig();
            } else {
                showToast("خطا: " + data.error, false);
            }
        })
        .fail((_, __, err) => showToast("خطا: " + err, false));
}

function deleteDay() {
    if (!confirm("آیا مطمئن هستید؟")) return;
    $.ajax({
        url: "/api/schedule-day",
        method: "POST",
        contentType: "application/json",
        data: JSON.stringify({ date: currentEditDay, windows: [] }),
    })
        .done((data) => {
            if (data.ok) {
                showToast("روز حذف شد");
                hideModal("dayEditModal");
                loadConfig();
            } else {
                showToast("خطا: " + data.error, false);
            }
        })
        .fail((_, __, err) => showToast("خطا: " + err, false));
}

// ==================== Main Actions ====================
function saveMainConfig() {
    const selected = $(".window-checkbox:checked").map((_, el) => $(el).val()).get();
    const mode = $("input[name='reserveMode']:checked").val() || "today";

    $.ajax({
        url: "/api/config",
        method: "POST",
        contentType: "application/json",
        data: JSON.stringify({ selectedWindows: selected, reserveDateMode: mode }),
    })
        .done((data) => {
            if (data.ok) {
                showToast("تنظیمات صفحه ذخیره شد");
                loadConfig();
            } else {
                showToast("خطا: " + data.error, false);
            }
        })
        .fail((_, __, err) => showToast("خطا: " + err, false));
}

function saveAdvancedSettings() {
    const priorityStr = $("#seatPriorityInput").val().trim();
    const priorityList = priorityStr
        .split(",")
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => !isNaN(n));

    if (!priorityList.length) {
        showToast("لیست اولویت صندلی نمی‌تواند خالی باشد", false);
        return;
    }

    const body = {
        username: $("#usernameInput").val(),
        passwd: $("#passwordInput").val(),
        seat_number: parseInt($("#seatNumberInput").val(), 10) || 33,
        seat_priority: priorityList,
        concurrency: parseInt($("#concurrencyInput").val(), 10) || 3,
        requestStartSpreadMs: parseInt($("#requestSpreadInput").val(), 10) || 400,
        sc: $("#scInput").val(),
        reserveDateMode: $("input[name='reserveMode']:checked").val() || "today",
    };

    $.ajax({
        url: "/api/settings",
        method: "POST",
        contentType: "application/json",
        data: JSON.stringify(body),
    })
        .done((data) => {
            if (data.ok) {
                showToast("تنظیمات ذخیره شدند");
                hideModal("settingsModal");
                loadConfig();
            } else {
                showToast("خطا: " + data.error, false);
            }
        })
        .fail((_, __, err) => showToast("خطا: " + err, false));
}

function reserveNow() {
    const selected = $(".window-checkbox:checked").map((_, el) => $(el).val()).get();
    if (!selected.length) {
        showToast("هیچ بازه‌ای انتخاب نشده است", false);
        return;
    }

    const $btn = $("#reserveNowBtn");
    $btn.prop("disabled", true).html("⏳ در حال رزرو...");

    $.ajax({
        url: "/api/reserve",
        method: "POST",
        contentType: "application/json",
        data: JSON.stringify({ windows: selected }),
    })
        .done((data) => {
            if (data.ok && data.results) {
                const successes = data.results.filter((x) => x.success).length;
                const total = data.results.length;
                showToast(`نتیجه: ${successes}/${total} رزرو موفق`);
                loadConfig();
            } else {
                showToast(data.error || "خطا در رزرو", false);
            }
        })
        .fail((_, __, err) => showToast("خطا: " + err, false))
        .always(() => {
            $btn.prop("disabled", false).html("🚀 رزرو فوری");
        });
}

function openCustomScheduleModal() {
    buildCustomScheduleUI();
    showModal("customScheduleModal");
}

function submitCustomSchedule() {
    const reserveDate = currentCustomReserveDate;
    const windows = $(".schedule-window:checked").map((_, el) => $(el).val()).get();
    const executionDate = $("#executionDateInput").val();
    const executionHour = parseInt($("#executionHourInput").val()) || 0;
    const executionMinute = parseInt($("#executionMinuteInput").val()) || 0;

    if (!reserveDate) {
        showToast("لطفاً روز رزرو را انتخاب کنید", false);
        return;
    }

    if (!windows.length) {
        showToast("حداقل یک بازه انتخاب شود", false);
        return;
    }

    if (!executionDate) {
        showToast("لطفاً تاریخ اجرا را مشخص کنید", false);
        return;
    }

    const $btn = $("#submitCustomScheduleBtn");
    const oldLabel = $btn.text();
    $btn.prop("disabled", true).text("⏳ در حال ثبت...");

    $.ajax({
        url: "/api/custom-schedule",
        method: "POST",
        contentType: "application/json",
        data: JSON.stringify({ 
            reserveDate, 
            windows, 
            executionDate,
            executionHour,
            executionMinute
        }),
    })
        .done((data) => {
            if (data.ok) {
                showToast("تایم‌بندی دلخواه ثبت شد", true);
                hideModal("customScheduleModal");
                loadConfig();
            } else {
                showToast(data.error || "خطا در ثبت تایم‌بندی", false);
            }
        })
        .fail((_, __, err) => showToast("خطا: " + err, false))
        .always(() => {
            $btn.prop("disabled", false).text(oldLabel);
        });
}

function deleteCustomSchedule(scheduleId) {
    if (!confirm("آیا میخواهید این تایم‌بندی را حذف کنید؟")) return;
    
    $.ajax({
        url: "/api/custom-schedule/" + scheduleId,
        method: "DELETE",
        contentType: "application/json"
    })
        .done((data) => {
            if (data.ok) {
                showToast("تایم‌بندی حذف شد", true);
                loadConfig();
            } else {
                showToast(data.error || "خطا در حذف", false);
            }
        })
        .fail((_, __, err) => showToast("خطا: " + err, false));
}

// ==================== Event Listeners ====================
$(function () {
    $("#openSettingsBtn").on("click", () => showModal("settingsModal"));
    $("#closeSettingsBtn").on("click", () => hideModal("settingsModal"));
    $("#closeDayEditBtn").on("click", () => hideModal("dayEditModal"));
    $("#closeCustomScheduleBtn").on("click", () => hideModal("customScheduleModal"));

    $("#saveConfigBtn").on("click", saveMainConfig);
    $("#reserveNowBtn").on("click", reserveNow);
    $("#customScheduleBtn").on("click", openCustomScheduleModal);
    $("#submitCustomScheduleBtn").on("click", submitCustomSchedule);
    $("#saveSettingsBtn").on("click", saveAdvancedSettings);
    $("#saveDayEditBtn").on("click", saveDayEdit);
    $("#deleteDayEditBtn").on("click", deleteDay);
    $("#toggleHistoryBtn").on("click", toggleHistory);

    $("#settingsModal").on("click", (e) => {
        if (e.target.id === "settingsModal") hideModal("settingsModal");
    });
    $("#dayEditModal").on("click", (e) => {
        if (e.target.id === "dayEditModal") hideModal("dayEditModal");
    });
    $("#customScheduleModal").on("click", (e) => {
        if (e.target.id === "customScheduleModal") hideModal("customScheduleModal");
    });

    initWebSocket();
    loadConfig();
    loadHistory();
    setInterval(loadConfig, 30000);
    setInterval(loadHistory, 30000);
});