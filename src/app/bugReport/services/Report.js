import _ from 'lodash';

/* @ngInject */
function Report($http, url, gettextCatalog) {
    const requestURL = url.build('reports');
    const I18N = {
        ERROR_REPORT: gettextCatalog.getString('Error communicating with the server', null, 'Report bug request'),
        ERROR_PHISHING: gettextCatalog.getString(
            'The phishing request failed, try again',
            null,
            'Report phishing request'
        )
    };
    const handleSuccess = ({ data = {} } = {}) => data;
    const handleError = (errorMessage) => ({ data = {} } = {}) => {
        throw new Error(data.Error || errorMessage);
    };

    const crash = (data) => $http.post(requestURL('crash'), data);
    const phishing = (data) =>
        $http
            .post(requestURL('phishing'), data)
            .then(handleSuccess)
            .catch(handleError(I18N.ERROR_PHISHING));
    const bug = (data) => {
        const config =
            data instanceof FormData
                ? {
                      transformRequest: angular.identity,
                      headers: {
                          'Content-Type': undefined
                      }
                  }
                : undefined;

        return $http
            .post(requestURL('bug'), data, config)
            .then(handleSuccess)
            .catch(handleError(I18N.ERROR_REPORT));
    };

    const uploadScreenshot = (image, form) =>
        new Promise((resolve, reject) => {
            /*
            We should use $http, but before we need to fix the interceptor
            to remove some headers before uploading an image to imgur.
         */
            $.ajax({
                url: 'https://api.imgur.com/3/image',
                headers: {
                    Authorization: 'Client-ID 864920c2f37d63f'
                },
                type: 'POST',
                data: { image },
                dataType: 'json',
                success({ data = {} } = {}) {
                    if (data.link) {
                        return resolve(
                            _.extend({}, form, {
                                Description: `${form.Description}\n\n\n\n${data.link}`
                            })
                        );
                    }
                    reject();
                },
                error: reject
            });
        });

    return { crash, bug, phishing, uploadScreenshot };
}
export default Report;
