importScripts("https://www.gstatic.com/firebasejs/12.14.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/12.14.0/firebase-messaging-compat.js");

firebase.initializeApp({

    apiKey: "AIzaSyDc6wwJq_iQtLoZT2RMA1-qyqN3U5W2ZL0",
    
    authDomain: "waater-65596.firebaseapp.com",
    projectId: "waater-65596",

    storageBucket: "waater-65596.firebasestorage.app",
    messagingSenderId: "840770803135",
    appId: "1:840770803135:web:1425f583ad04315b87fd0a"

});

const messaging = firebase.messaging();


messaging.onBackgroundMessage((payload) => {

    const { title, body, url } = payload.data || {};

    self.registration.showNotification(title || "Waater", {
        
        body,

        icon: "/icon-192.png",

        data: { url: url || '/' }

    });
});



self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const url = event.notification.data?.url || '/';
    event.waitUntil(clients.openWindow(url));
});

