// MITM patching code adapted from:
// https://github.com/shroudedcode/apk-mitm
// MIT © Niklas Higi

import * as fs from "fs";
import * as path from "path";
import * as xml from "xml-js";
import * as globby from "globby";
import * as escapeStringRegexp from "escape-string-regexp";
import * as vscode from "vscode";
import { outputChannel } from "./common";
import { quickPickUtil } from "./quick-pick.util";

const DEFAULT_CONFIG = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <base-config cleartextTrafficPermitted="true">
        <trust-anchors>
            <certificates src="user" />
        </trust-anchors>
    </base-config>
</network-security-config>`;

const INTERFACE_LINE = ".implements Ljavax/net/ssl/X509TrustManager;";

/** The methods that need to be patched to disable certificate pinning. */
const METHOD_SIGNATURES = [
    "checkClientTrusted([Ljava/security/cert/X509Certificate;Ljava/lang/String;)V",
    "checkServerTrusted([Ljava/security/cert/X509Certificate;Ljava/lang/String;)V",
    "getAcceptedIssuers()[Ljava/security/cert/X509Certificate;",
];

/** Patterns used to find the methods defined in `METHOD_SIGNATURES`. */
const METHOD_PATTERNS = METHOD_SIGNATURES.map((signature) => {
    const escapedSignature = escapeStringRegexp(signature);
    return new RegExp(
        `(\\.method public (?:final )?${escapedSignature})\\n([^]+?)\\n(\\.end method)`,
        "g"
    );
});

/** Code inserted into `checkClientTrusted` and `checkServerTrusted`. */
const RETURN_VOID_FIX = [".locals 0", "return-void"];

/** Code inserted into `getAcceptedIssuers`. */
const RETURN_EMPTY_ARRAY_FIX = [
    ".locals 1",
    "const/4 v0, 0x0",
    "new-array v0, v0, [Ljava/security/cert/X509Certificate;",
    "return-object v0",
];

/**
 * Create network security config file path
 * @param decodeDir The path of decoded file.
 */
async function createNetworkSecurityConfig(decodeDir: string) {
    const manifestPath = path.join(decodeDir, "AndroidManifest.xml");
    const nscPath = path.join(decodeDir, `res/xml/nsc_apklab.xml`);

    const manifestContent = await fs.promises.readFile(manifestPath, {
        encoding: "utf-8",
    });

    const fileXml: { [index: string]: any } = xml.xml2js(manifestContent, {
        compact: true,
        alwaysArray: true,
    });

    outputChannel.appendLine("Creating default network security config file");

    await fs.promises.mkdir(path.dirname(nscPath), { recursive: true });
    await fs.promises.writeFile(nscPath, DEFAULT_CONFIG);

    const manifest = fileXml["manifest"][0];
    const application = manifest["application"][0];

    application._attributes["android:networkSecurityConfig"] =
        "@xml/nsc_apklab";

    await fs.promises.writeFile(
        manifestPath,
        xml.js2xml(fileXml, { compact: true, spaces: 4 })
    );
}

/**
 * Disable certificate pinning
 * @param directoryPath Base path for decoded smali.
 */
async function disableCertificatePinning(directoryPath: string) {
    const smaliPath = directoryPath.split(path.sep).join(path.posix.sep);

    const smaliFiles = await globby(
        path.posix.join(smaliPath, "smali*/**/*.smali")
    );

    let pinningFound = false;

    outputChannel.appendLine(`Analyzing ${smaliFiles.length} smali files`);

    for (const smaliFile of smaliFiles) {
        const filePath = smaliFile.split(path.posix.sep).join(path.sep);

        let originalContent = await fs.promises.readFile(filePath, "utf-8");

        // Don't scan classes that don't implement the interface
        if (!originalContent.includes(INTERFACE_LINE)) {
            continue;
        }

        if (process.platform.startsWith("win")) {
            originalContent = originalContent.replace(/\r\n/g, "\n");
        }

        let patchedContent = originalContent;

        for (const pattern of METHOD_PATTERNS) {
            patchedContent = patchedContent.replace(
                pattern,
                (_, openingLine: string, body: string, closingLine: string) => {
                    const bodyLines = body
                        .split("\n")
                        .map((line) => line.replace(/^ {4}/, ""));

                    const fixLines = openingLine.includes("getAcceptedIssuers")
                        ? RETURN_EMPTY_ARRAY_FIX
                        : RETURN_VOID_FIX;

                    const patchedBodyLines = [
                        "# inserted by APKLab to disable certificate pinning",
                        ...fixLines,
                        "",
                        "# commented out by APKLab to disable old method body",
                        "# ",
                        ...bodyLines.map((line) => `# ${line}`),
                    ];

                    return [
                        openingLine,
                        ...patchedBodyLines.map((line) => `    ${line}`),
                        closingLine,
                    ]
                        .map((line) => line.replace(/\s+$/, ""))
                        .join("\n");
                }
            );
        }

        if (originalContent !== patchedContent) {
            pinningFound = true;
            outputChannel.appendLine(`Applying patch in ${filePath}`);
            if (process.platform.startsWith("win")) {
                patchedContent = patchedContent.replace(/\n/g, "\r\n");
            }
            await fs.promises.writeFile(filePath, patchedContent);
        }
    }

    if (!pinningFound) {
        outputChannel.appendLine("No certificate pinning logic found.");
    }
}

export namespace mitmTools {
    /**
     * Apply patch to intercept HTTPS calls
     * @param apktoolYmlPath The path of `apktool.yml` file.
     */
    export async function applyMitmPatch(
        apktoolYmlPath: string
    ): Promise<void> {
        try {
            const report = "Applying patch for HTTPS inspection (MITM)";

            outputChannel.show();
            outputChannel.appendLine("-".repeat(report.length));
            outputChannel.appendLine(report);
            outputChannel.appendLine("-".repeat(report.length));

            const decodeDir = path.dirname(apktoolYmlPath);

            await createNetworkSecurityConfig(decodeDir);
            await disableCertificatePinning(decodeDir);

            quickPickUtil.setQuickPickDefault(
                "rebuildQuickPickItems",
                "--debug"
            );

            outputChannel.appendLine("MITM Patch applied successfully");
            vscode.window.showInformationMessage(
                `APKLab: MITM Patch applied successfully`
            );
        } catch (err) {
            outputChannel.appendLine(err);
            outputChannel.appendLine("Failed to apply MITM patch");
            vscode.window.showErrorMessage(
                `APKLab: Failed to apply MITM patch`
            );
        }
    }
}
