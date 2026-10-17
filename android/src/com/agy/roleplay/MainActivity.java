package com.agy.roleplay;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.DialogInterface;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.view.ViewGroup;
import android.webkit.JsPromptResult;
import android.webkit.JsResult;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.FrameLayout;

import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

public class MainActivity extends Activity {
    private static final int FILE_CHOOSER_RESULT_CODE = 1001;
    private static final int SAVE_DOCUMENT_RESULT_CODE = 1002;
    private WebView webView;
    private FrameLayout rootLayout;
    private ValueCallback<Uri[]> filePathCallback;
    private LocalBackendServer localBackendServer;
    private String pendingSaveContent;

    public void startSaveDocument(final String filename, final String content, final String mimeType) {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    pendingSaveContent = content != null ? content : "";
                    Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    intent.setType(mimeType != null && !mimeType.isEmpty() ? mimeType : "text/plain");
                    intent.putExtra(Intent.EXTRA_TITLE, filename != null && !filename.isEmpty() ? filename : "chat_export.md");
                    startActivityForResult(intent, SAVE_DOCUMENT_RESULT_CODE);
                } catch (Exception ignored) {
                }
            }
        });
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        Window window = getWindow();
        if (window != null) {
            window.setStatusBarColor(Color.parseColor("#0F1115"));
            window.setNavigationBarColor(Color.parseColor("#13161C"));
        }

        rootLayout = new FrameLayout(this);
        rootLayout.setBackgroundColor(Color.parseColor("#0F1115"));

        webView = new WebView(this);
        webView.setBackgroundColor(Color.parseColor("#0F1115"));

        // Handle Android 15 / Android 16 (API 35/36) forced Edge-to-Edge WindowInsets + Keyboard (IME)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            rootLayout.setOnApplyWindowInsetsListener(new View.OnApplyWindowInsetsListener() {
                private boolean lastKbOpen = false;

                @Override
                public WindowInsets onApplyWindowInsets(View v, WindowInsets insets) {
                    Insets sysBars = insets.getInsets(
                        WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout()
                    );
                    Insets ime = insets.getInsets(WindowInsets.Type.ime());
                    int bottomPad = Math.max(sysBars.bottom, ime.bottom);
                    v.setPadding(sysBars.left, sysBars.top, sysBars.right, bottomPad);

                    final boolean kbOpen = ime.bottom > (sysBars.bottom + 80);
                    if (kbOpen != lastKbOpen) {
                        lastKbOpen = kbOpen;
                        webView.post(new Runnable() {
                            @Override
                            public void run() {
                                try {
                                    webView.evaluateJavascript(
                                        "window.onAndroidKeyboardVisibilityChanged && window.onAndroidKeyboardVisibilityChanged(" + (kbOpen ? "true" : "false") + ");",
                                        null
                                    );
                                } catch (Exception ignored) {
                                }
                            }
                        });
                    }
                    return WindowInsets.CONSUMED;
                }
            });
        } else {
            rootLayout.setFitsSystemWindows(true);
        }

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        settings.setAllowFileAccessFromFileURLs(true);
        settings.setAllowUniversalAccessFromFileURLs(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
        settings.setTextZoom(100);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (uri != null && uri.getPath() != null && uri.getPath().endsWith(".apk")) {
                    Intent browserIntent = new Intent(Intent.ACTION_VIEW, uri);
                    startActivity(browserIntent);
                    return true;
                }
                return false;
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            // Android 16 Photo Picker / File Chooser for Character & Persona Avatars
            @Override
            public boolean onShowFileChooser(
                WebView webView,
                ValueCallback<Uri[]> filePathCallback,
                FileChooserParams fileChooserParams
            ) {
                if (MainActivity.this.filePathCallback != null) {
                    MainActivity.this.filePathCallback.onReceiveValue(null);
                }
                MainActivity.this.filePathCallback = filePathCallback;

                Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("image/*");

                try {
                    startActivityForResult(Intent.createChooser(intent, "Выберите изображение персонажа"), FILE_CHOOSER_RESULT_CODE);
                } catch (Exception e) {
                    MainActivity.this.filePathCallback = null;
                    return false;
                }
                return true;
            }

            @Override
            public boolean onJsAlert(WebView view, String url, String message, final JsResult result) {
                new AlertDialog.Builder(MainActivity.this)
                    .setTitle("AGY Roleplay")
                    .setMessage(message)
                    .setPositiveButton("OK", new DialogInterface.OnClickListener() {
                        @Override
                        public void onClick(DialogInterface dialog, int which) {
                            result.confirm();
                        }
                    })
                    .setCancelable(false)
                    .show();
                return true;
            }

            @Override
            public boolean onJsConfirm(WebView view, String url, String message, final JsResult result) {
                new AlertDialog.Builder(MainActivity.this)
                    .setTitle("Подтверждение")
                    .setMessage(message)
                    .setPositiveButton("Да", new DialogInterface.OnClickListener() {
                        @Override
                        public void onClick(DialogInterface dialog, int which) {
                            result.confirm();
                        }
                    })
                    .setNegativeButton("Отмена", new DialogInterface.OnClickListener() {
                        @Override
                        public void onClick(DialogInterface dialog, int which) {
                            result.cancel();
                        }
                    })
                    .setCancelable(false)
                    .show();
                return true;
            }

            @Override
            public boolean onJsPrompt(WebView view, String url, String message, String defaultValue, final JsPromptResult result) {
                final EditText input = new EditText(MainActivity.this);
                input.setText(defaultValue != null ? defaultValue : "");
                new AlertDialog.Builder(MainActivity.this)
                    .setTitle(message)
                    .setView(input)
                    .setPositiveButton("Создать", new DialogInterface.OnClickListener() {
                        @Override
                        public void onClick(DialogInterface dialog, int which) {
                            result.confirm(input.getText().toString());
                        }
                    })
                    .setNegativeButton("Отмена", new DialogInterface.OnClickListener() {
                        @Override
                        public void onClick(DialogInterface dialog, int which) {
                            result.cancel();
                        }
                    })
                    .setCancelable(false)
                    .show();
                return true;
            }
        });

        localBackendServer = new LocalBackendServer(this, webView);
        webView.addJavascriptInterface(localBackendServer, "AndroidServer");

        rootLayout.addView(webView, new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        ));

        setContentView(rootLayout);
        webView.loadUrl(localBackendServer.getStartPageUrl());
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == FILE_CHOOSER_RESULT_CODE) {
            if (filePathCallback == null) return;
            Uri[] results = null;
            if (resultCode == Activity.RESULT_OK && data != null) {
                String dataString = data.getDataString();
                if (dataString != null) {
                    results = new Uri[]{Uri.parse(dataString)};
                }
            }
            filePathCallback.onReceiveValue(results);
            filePathCallback = null;
            return;
        }
        if (requestCode == SAVE_DOCUMENT_RESULT_CODE) {
            if (resultCode == Activity.RESULT_OK && data != null && data.getData() != null && pendingSaveContent != null) {
                try {
                    OutputStream os = getContentResolver().openOutputStream(data.getData());
                    if (os != null) {
                        os.write(pendingSaveContent.getBytes(StandardCharsets.UTF_8));
                        os.flush();
                        os.close();
                        if (webView != null) {
                            webView.evaluateJavascript("if(window.__onNativeFileSaved)window.__onNativeFileSaved(true);", null);
                        }
                    }
                } catch (Exception e) {
                    if (webView != null) {
                        webView.evaluateJavascript("if(window.__onNativeFileSaved)window.__onNativeFileSaved(false);", null);
                    }
                }
            }
            pendingSaveContent = null;
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    public void onBackPressed() {
        if (webView != null) {
            webView.evaluateJavascript(
                "(function(){" +
                "  var openModals = document.querySelectorAll('.modal-overlay:not(.hidden)');" +
                "  if (openModals.length > 0) { openModals[openModals.length - 1].classList.add('hidden'); return 'modal'; }" +
                "  var chatRoom = document.getElementById('chatRoomView');" +
                "  if (chatRoom && !chatRoom.classList.contains('hidden')) { window.appUI.closeChatRoom(); return 'chat'; }" +
                "  return 'exit';" +
                "})()",
                new ValueCallback<String>() {
                    @Override
                    public void onReceiveValue(String value) {
                        if (value != null && value.contains("exit")) {
                            MainActivity.super.onBackPressed();
                        }
                    }
                }
            );
        } else {
            super.onBackPressed();
        }
    }
}
